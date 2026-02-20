## System Design: Building a Real-Time Chat Application

I have been through three system design rounds this year alone, and real-time chat comes up more than anything else. But beyond interviews, I have actually built messaging systems at two companies. The gap between a whiteboard answer and a production system is enormous. This post is what I wish someone had written for me before I started.

### Problem Statement

We are building a chat application that supports:

**Functional Requirements:**
- One-on-one and group messaging
- Real-time message delivery (sub-second latency)
- Message persistence and history
- Online/offline presence indicators
- Read receipts
- Push notifications for offline users

**Non-Functional Requirements:**
- 10 million daily active users
- 99.99% availability
- Messages delivered in order within a conversation
- End-to-end latency under 200ms for online users
- Messages stored for 5 years

### High-Level Architecture

Here is how the major components connect:

```
Clients (Web/Mobile)
       |
       | WebSocket (STOMP)
       v
[Load Balancer (Layer 7)]
       |
       v
[Chat Server Cluster] <---> [Redis Pub/Sub] <---> [Chat Server Cluster]
       |                           |
       v                           v
[Message Queue (Kafka)]     [Presence Service (Redis)]
       |
       v
[Message Persistence (PostgreSQL)]
       |
       v
[Push Notification Service]
```

The key insight: **Chat servers are stateful** because they hold WebSocket connections. Redis Pub/Sub bridges the gap when two users connected to different servers need to talk.

### Technology Choices

| Component | Technology | Why |
|---|---|---|
| Real-time transport | WebSocket + STOMP | Full-duplex, Spring has first-class support |
| Message broker | Redis Pub/Sub | Low latency, simple, handles cross-server routing |
| Persistent queue | Apache Kafka | Durability, replay, decouples write path |
| Database | PostgreSQL | JSONB for flexible message metadata, strong consistency |
| Presence | Redis | TTL-based keys, sub-millisecond reads |
| Push notifications | Firebase Cloud Messaging | Industry standard, handles both iOS and Android |

### WebSocket Implementation with Spring

Spring's STOMP over WebSocket support is production-tested and saves you from writing low-level frame handling.

**WebSocket Configuration:**

```java
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        // Use Redis-backed broker for multi-instance support
        config.enableStompBrokerRelay("/topic", "/queue")
              .setRelayHost("redis-host")
              .setRelayPort(6379);
        config.setApplicationDestinationPrefixes("/app");
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws/chat")
                .setAllowedOrigins("https://yourchatapp.com")
                .withSockJS(); // Fallback for older browsers
    }
}
```

**Message Handler:**

```java
@Controller
public class ChatController {

    private final MessagePersistenceService persistenceService;
    private final PresenceService presenceService;
    private final PushNotificationService pushService;

    @MessageMapping("/chat.send")
    public void sendMessage(@Payload ChatMessage message,
                            SimpMessageHeaderAccessor headerAccessor) {

        String senderId = headerAccessor.getUser().getName();
        message.setSenderId(senderId);
        message.setTimestamp(Instant.now());
        message.setMessageId(UUID.randomUUID().toString());

        // Persist asynchronously via Kafka
        persistenceService.persistAsync(message);

        // Route to recipient
        String recipientId = message.getRecipientId();

        if (presenceService.isOnline(recipientId)) {
            messagingTemplate.convertAndSendToUser(
                recipientId,
                "/queue/messages",
                message
            );
        } else {
            // User offline -- queue push notification
            pushService.sendPushNotification(recipientId, message);
        }
    }

    @MessageMapping("/chat.typing")
    public void typingIndicator(@Payload TypingEvent event,
                                SimpMessageHeaderAccessor headerAccessor) {
        messagingTemplate.convertAndSendToUser(
            event.getRecipientId(),
            "/queue/typing",
            event
        );
    }

    @Autowired
    private SimpMessagingTemplate messagingTemplate;
}
```

### Message Persistence and Delivery Guarantees

Messages flow through Kafka before hitting PostgreSQL. This decouples the hot path (WebSocket delivery) from the cold path (database write). Even if the database is slow, the user sees the message instantly.

For delivery guarantees, I track three states:

- **SENT** -- server received the message
- **DELIVERED** -- recipient's client acknowledged receipt
- **READ** -- recipient opened the conversation

```java
@Entity
@Table(name = "messages")
public class Message {

    @Id
    private String messageId;
    private String conversationId;
    private String senderId;
    private String content;
    private Instant timestamp;

    @Enumerated(EnumType.STRING)
    private DeliveryStatus status; // SENT, DELIVERED, READ

    private Instant deliveredAt;
    private Instant readAt;
}
```

The client sends an acknowledgment back over the WebSocket when it receives a message. This flips the status from SENT to DELIVERED. Simple, reliable.

### Presence System with Redis

Presence is one of those features that looks trivial but gets tricky at scale. I use Redis TTL keys:

```java
@Service
public class PresenceService {

    private final StringRedisTemplate redisTemplate;
    private static final Duration PRESENCE_TTL = Duration.ofSeconds(30);

    public void markOnline(String userId, String serverId) {
        String key = "presence:" + userId;
        Map<String, String> value = Map.of(
            "serverId", serverId,
            "lastSeen", Instant.now().toString()
        );
        redisTemplate.opsForHash().putAll(key, value);
        redisTemplate.expire(key, PRESENCE_TTL);
    }

    public boolean isOnline(String userId) {
        return Boolean.TRUE.equals(
            redisTemplate.hasKey("presence:" + userId)
        );
    }

    public void heartbeat(String userId) {
        redisTemplate.expire("presence:" + userId, PRESENCE_TTL);
    }
}
```

Clients send a heartbeat every 15 seconds. If the key expires (no heartbeat for 30 seconds), the user is considered offline. No complex state machine needed.

### Scaling WebSockets Horizontally

This is where most designs fall apart. User A is connected to Server 1, User B is connected to Server 2. How does A's message reach B?

**Redis Pub/Sub** solves this. Each chat server subscribes to a channel. When Server 1 receives a message for User B, it publishes to Redis. Server 2 picks it up and delivers over its local WebSocket.

```java
@Service
public class RedisMessageRelay {

    private final StringRedisTemplate redisTemplate;
    private final SimpMessagingTemplate messagingTemplate;

    public void relayMessage(ChatMessage message) {
        String channel = "chat:user:" + message.getRecipientId();
        redisTemplate.convertAndSend(channel,
            objectMapper.writeValueAsString(message));
    }

    @Bean
    public MessageListenerAdapter messageListener() {
        return new MessageListenerAdapter((MessageListener) (message, pattern) -> {
            ChatMessage chatMessage = objectMapper.readValue(
                message.getBody(), ChatMessage.class);
            messagingTemplate.convertAndSendToUser(
                chatMessage.getRecipientId(),
                "/queue/messages",
                chatMessage
            );
        });
    }
}
```

For group chats with many participants, fan-out happens at the Redis layer. Each server only delivers to users connected to it.

### Message Ordering and Consistency

Messages within a single conversation must be ordered. I use a **Snowflake-like ID generator** that produces time-sortable, globally unique IDs. The conversation is partitioned in Kafka by `conversationId`, so messages within a conversation are always processed in order.

On the client side, messages are sorted by their server-assigned timestamp, not the client's local time. Never trust the client clock.

### Database Schema

```sql
CREATE TABLE users (
    user_id     VARCHAR(36) PRIMARY KEY,
    username    VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100),
    avatar_url  TEXT,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE conversations (
    conversation_id VARCHAR(36) PRIMARY KEY,
    type            VARCHAR(10) NOT NULL, -- 'DIRECT' or 'GROUP'
    name            VARCHAR(100),
    created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE conversation_members (
    conversation_id VARCHAR(36) REFERENCES conversations(conversation_id),
    user_id         VARCHAR(36) REFERENCES users(user_id),
    joined_at       TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
    message_id      VARCHAR(36) PRIMARY KEY,
    conversation_id VARCHAR(36) REFERENCES conversations(conversation_id),
    sender_id       VARCHAR(36) REFERENCES users(user_id),
    content         TEXT NOT NULL,
    status          VARCHAR(10) DEFAULT 'SENT',
    created_at      TIMESTAMP DEFAULT NOW(),
    delivered_at    TIMESTAMP,
    read_at         TIMESTAMP
);

-- Critical indexes for query performance
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_conversation_members_user ON conversation_members(user_id);
```

Partition the `messages` table by `created_at` (monthly partitions) once you pass a few hundred million rows. Old partitions can be moved to cold storage.

### Capacity Estimation

Let us do some quick math for 10 million DAU:

- Average user sends **20 messages/day**
- Total: **200 million messages/day** (~2,300 messages/second)
- Average message size: **200 bytes** (content + metadata)
- Daily storage: **200M x 200B = 40 GB/day**
- Annual storage: **~14.6 TB/year**
- 5-year retention: **~73 TB**

For WebSocket connections: 10M concurrent connections at peak. At ~10KB memory per connection, that is **100 GB of RAM** across the cluster. With 16 GB allocated per server instance, you need roughly **7-8 chat server instances** at peak. In practice, I would run 12-15 for headroom and fault tolerance.

Redis Pub/Sub handles 500K+ messages/second on a single node, so one Redis cluster with a few replicas covers us comfortably.

### Push Notifications for Offline Users

When the presence check says a user is offline, the message gets routed to a notification queue:

```java
@Service
public class PushNotificationService {

    private final FirebaseMessaging firebaseMessaging;

    public void sendPushNotification(String userId, ChatMessage message) {
        String fcmToken = tokenRepository.getToken(userId);
        if (fcmToken == null) return;

        Message notification = Message.builder()
            .setToken(fcmToken)
            .setNotification(Notification.builder()
                .setTitle(message.getSenderName())
                .setBody(truncate(message.getContent(), 100))
                .build())
            .putData("conversationId", message.getConversationId())
            .build();

        firebaseMessaging.sendAsync(notification);
    }
}
```

Batch notifications if a user has many unread messages. Nobody wants 50 separate push alerts.

### Conclusion

System design is fundamentally about **trade-offs**. In this chat system, we traded the simplicity of a stateless HTTP API for the complexity of stateful WebSocket connections -- because sub-second latency demanded it. We added Redis as a coordination layer, accepting the operational overhead because the alternative (sticky sessions with no failover) is worse. We chose eventual consistency for read receipts because strong consistency there would crush throughput for no real user benefit.

Every decision has a cost. The skill is not in memorizing architectures -- it is in understanding **why** each piece exists and **what breaks** if you remove it. That is what separates a whiteboard answer from a system that actually runs at scale.
