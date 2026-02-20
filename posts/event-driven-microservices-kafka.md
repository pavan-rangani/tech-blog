Apache Kafka has become the backbone of event-driven architectures. Having used it extensively in production systems handling millions of events daily, I want to share practical patterns that go beyond the basics.

## Why Event-Driven?

Traditional request-response architectures create tight coupling between services. When Service A directly calls Service B, both must be available simultaneously, and changes in B's API break A.

Event-driven architecture inverts this relationship:

```
Traditional:    Service A  →  Service B  →  Service C
                (coupled, synchronous, brittle)

Event-Driven:   Service A  →  [Kafka]  ←  Service B
                                       ←  Service C
                (decoupled, async, resilient)
```

Services publish events about what happened. Other services subscribe to events they care about. No service needs to know about any other service.

## Kafka Fundamentals in Practice

### Topic Design

Topic design is the foundation. A common mistake is creating too many topics or too few. Here's my approach:

```
# One topic per aggregate/domain event type
order-events        → OrderCreated, OrderUpdated, OrderCancelled
payment-events      → PaymentProcessed, PaymentFailed, RefundIssued
inventory-events    → StockReserved, StockReleased, LowStockAlert
```

**Partitioning strategy**: Partition by the entity's natural key (e.g., `orderId`). This guarantees ordering for related events while allowing parallel processing.

```java
@Configuration
public class KafkaTopicConfig {

    @Bean
    public NewTopic orderEvents() {
        return TopicBuilder.name("order-events")
            .partitions(12)
            .replicas(3)
            .config(TopicConfig.RETENTION_MS_CONFIG, "604800000") // 7 days
            .build();
    }
}
```

## Producer Patterns

### Transactional Outbox Pattern

The biggest challenge with event-driven systems: ensuring the database write and event publish happen atomically. The outbox pattern solves this.

```java
@Service
@Transactional
public class OrderService {

    private final OrderRepository orderRepo;
    private final OutboxRepository outboxRepo;

    public Order createOrder(OrderRequest request) {
        // 1. Save the order
        Order order = orderRepo.save(new Order(request));

        // 2. Write event to outbox table (same transaction)
        outboxRepo.save(new OutboxEvent(
            "order-events",
            order.getId().toString(),
            "OrderCreated",
            toJson(order)
        ));

        return order;
        // Transaction commits: both order AND outbox event are saved atomically
    }
}
```

A separate process (Debezium CDC or a scheduled poller) reads the outbox table and publishes to Kafka:

```java
@Scheduled(fixedDelay = 1000)
public void publishOutboxEvents() {
    List<OutboxEvent> events = outboxRepo.findUnpublished();
    for (OutboxEvent event : events) {
        kafkaTemplate.send(event.getTopic(), event.getKey(), event.getPayload());
        event.markPublished();
        outboxRepo.save(event);
    }
}
```

## Consumer Patterns

### Idempotent Consumer

Network issues and rebalances mean consumers may receive the same message twice. Your consumers must be idempotent.

```java
@KafkaListener(topics = "order-events", groupId = "payment-service")
public void handleOrderEvent(ConsumerRecord<String, String> record) {
    String eventId = record.headers()
        .lastHeader("eventId").value().toString();

    // Check if already processed
    if (processedEventRepo.existsByEventId(eventId)) {
        log.info("Duplicate event ignored: {}", eventId);
        return;
    }

    // Process the event
    OrderEvent event = deserialize(record.value());
    paymentService.processPayment(event);

    // Mark as processed
    processedEventRepo.save(new ProcessedEvent(eventId));
}
```

### Dead Letter Queue (DLQ)

Messages that fail after retries should go to a dead letter topic for investigation, not be silently dropped.

```java
@Bean
public ConcurrentKafkaListenerContainerFactory<String, String> kafkaListenerFactory() {
    ConcurrentKafkaListenerContainerFactory<String, String> factory =
        new ConcurrentKafkaListenerContainerFactory<>();

    factory.setConsumerFactory(consumerFactory());
    factory.setCommonErrorHandler(new DefaultErrorHandler(
        new DeadLetterPublishingRecoverer(kafkaTemplate),
        new FixedBackOff(1000L, 3) // 3 retries, 1 second apart
    ));

    return factory;
}
```

## Event Sourcing with Kafka

Instead of storing current state, store the sequence of events that led to the current state. Kafka's immutable, ordered log makes it a natural fit.

```
Event Store (Kafka Topic: order-events)
┌──────────────────────────────────────────────────┐
│ OrderCreated │ ItemAdded │ ItemAdded │ OrderPaid  │
│  (t=1)       │  (t=2)    │  (t=3)    │  (t=4)    │
└──────────────────────────────────────────────────┘
                    ↓ Replay events
            Current State: Order {
              items: [item1, item2],
              status: PAID,
              total: $150.00
            }
```

This approach gives you a complete audit trail, the ability to replay events to rebuild state, and time-travel debugging.

## Monitoring Kafka in Production

Key metrics to monitor:

| Metric | Alert Threshold | Why |
|--------|----------------|-----|
| Consumer lag | > 10,000 messages | Consumer falling behind |
| Under-replicated partitions | > 0 | Data durability at risk |
| Request latency (p99) | > 500ms | Broker performance degradation |
| ISR shrink rate | > 0 | Broker health issues |

```yaml
# Prometheus + Grafana dashboard queries
kafka_consumer_lag_sum{group="payment-service"} > 10000
kafka_server_under_replicated_partitions > 0
```

## Performance Tuning Tips

**Producer side:**
- Use `acks=all` for critical data, `acks=1` for high-throughput non-critical data
- Batch messages: `batch.size=32768`, `linger.ms=20`
- Enable compression: `compression.type=lz4`

**Consumer side:**
- Increase `max.poll.records` for batch processing
- Use `fetch.min.bytes` to reduce network calls
- Match partition count to consumer instances for parallelism

## Final Thoughts

Event-driven architecture with Kafka is powerful but introduces operational complexity. Start with simple pub/sub patterns, master idempotency and error handling, and evolve toward event sourcing only when the business requirements justify it.

The systems I'm most proud of aren't the ones with the most sophisticated event patterns — they're the ones where events flow reliably, failures are handled gracefully, and the team can debug issues by reading the event stream like a story.
