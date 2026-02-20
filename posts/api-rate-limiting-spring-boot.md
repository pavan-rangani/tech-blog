## API Rate Limiting and Throttling in Spring Boot

I learned the importance of rate limiting the hard way. A few years back, one of our public-facing APIs got hammered by a misbehaving client script running in an infinite loop. No rate limiting in place. The service went down, took out two downstream systems with it, and we spent the weekend doing a post-mortem. Since then, **rate limiting is non-negotiable** in every API I ship.

Let me walk you through how I implement rate limiting in Spring Boot, from the theory to production-ready code.

### Why Rate Limiting Matters

Without rate limiting, your API is an open buffet. Anyone can consume as much as they want, and your legitimate users pay the price. Here is what rate limiting protects you from:

- **Denial of Service** -- intentional or accidental abuse
- **Resource exhaustion** -- database connections, thread pools, memory
- **Cost overruns** -- especially if you are paying per-request to downstream services
- **Unfair usage** -- one tenant hogging everything in a multi-tenant system

### Types of Rate Limiting Algorithms

Before writing any code, you should understand the algorithms available. Each has trade-offs.

| Algorithm | How It Works | Pros | Cons |
|---|---|---|---|
| **Fixed Window** | Counts requests in fixed time intervals (e.g., 100 req/min) | Simple to implement | Burst at window edges |
| **Sliding Window** | Rolling time window, smooths out edge bursts | Fairer distribution | Slightly more complex |
| **Token Bucket** | Tokens refill at a fixed rate; each request costs a token | Allows controlled bursts | Needs careful tuning |
| **Leaky Bucket** | Requests queue and process at a constant rate | Smooth output rate | Can add latency |

For most Spring Boot APIs, I go with **Token Bucket**. It handles bursty traffic naturally and is what Bucket4j implements under the hood.

### Implementing Rate Limiting with Bucket4j

Bucket4j is a Java library based on the token bucket algorithm. It integrates cleanly with Spring Boot and supports both in-memory and distributed (Redis, Hazelcast) backends.

Add the dependency:

```xml
<dependency>
    <groupId>com.bucket4j</groupId>
    <artifactId>bucket4j-core</artifactId>
    <version>8.7.0</version>
</dependency>
```

Here is a basic bucket configuration -- 20 requests per minute with a burst capacity of 5:

```java
import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.Refill;

import java.time.Duration;

public class RateLimiterConfig {

    public static Bucket createBucket() {
        Bandwidth limit = Bandwidth.classic(20, Refill.greedy(20, Duration.ofMinutes(1)));
        Bandwidth burst = Bandwidth.classic(5, Refill.intervally(5, Duration.ofSeconds(10)));

        return Bucket.builder()
                .addLimit(limit)
                .addLimit(burst)
                .build();
    }
}
```

### Building a Rate Limiting Filter

I prefer using a `HandlerInterceptor` over a servlet filter. It gives you access to Spring's context and plays well with the rest of the framework.

```java
@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response,
                             Object handler) throws Exception {

        String clientId = resolveClientId(request);
        Bucket bucket = buckets.computeIfAbsent(clientId, k -> createBucket());

        ConsumptionProbe probe = bucket.tryConsumeAndReturnRemaining(1);

        response.addHeader("X-RateLimit-Limit", "20");
        response.addHeader("X-RateLimit-Remaining",
                String.valueOf(probe.getRemainingTokens()));

        if (probe.isConsumed()) {
            return true;
        }

        long waitTimeSeconds = probe.getNanosToWaitForRefill() / 1_000_000_000;
        response.addHeader("Retry-After", String.valueOf(waitTimeSeconds));
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.getWriter().write(
            "{\"error\": \"Rate limit exceeded. Try again in "
            + waitTimeSeconds + " seconds.\"}"
        );
        return false;
    }

    private String resolveClientId(HttpServletRequest request) {
        // Prefer API key, fall back to IP
        String apiKey = request.getHeader("X-API-Key");
        if (apiKey != null && !apiKey.isBlank()) {
            return "key:" + apiKey;
        }
        return "ip:" + request.getRemoteAddr();
    }

    private Bucket createBucket() {
        return Bucket.builder()
                .addLimit(Bandwidth.classic(20,
                    Refill.greedy(20, Duration.ofMinutes(1))))
                .build();
    }
}
```

Register it in your WebMvc configuration:

```java
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Autowired
    private RateLimitInterceptor rateLimitInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(rateLimitInterceptor)
                .addPathPatterns("/api/**");
    }
}
```

### Per-User vs Per-Endpoint Rate Limiting

The interceptor above does **per-user** limiting. But sometimes you need per-endpoint limits too -- a search endpoint might be more expensive than a profile lookup.

I combine both by keying the bucket on `clientId + endpoint`:

```java
private String resolveBucketKey(HttpServletRequest request) {
    String clientId = resolveClientId(request);
    String endpoint = request.getMethod() + ":" + request.getRequestURI();
    return clientId + "|" + endpoint;
}
```

You can then define different `Bandwidth` limits based on the endpoint pattern. I typically keep these in a configuration map:

```java
Map<String, Bandwidth> endpointLimits = Map.of(
    "/api/search",  Bandwidth.classic(10, Refill.greedy(10, Duration.ofMinutes(1))),
    "/api/users",   Bandwidth.classic(50, Refill.greedy(50, Duration.ofMinutes(1)))
);
```

### Distributed Rate Limiting with Redis

In-memory buckets break the moment you scale beyond one instance. Two pods, each with its own bucket, means your effective limit doubles. The fix is **Redis**.

Bucket4j has a Redis integration via bucket4j-redis:

```xml
<dependency>
    <groupId>com.bucket4j</groupId>
    <artifactId>bucket4j-redis</artifactId>
    <version>8.7.0</version>
</dependency>
```

```java
@Bean
public ProxyManager<String> proxyManager(LettuceConnectionFactory connectionFactory) {
    StatefulRedisConnection<String, byte[]> connection =
        connectionFactory.getStatefulConnection();
    return Bucket4jRedis.casBasedBuilder(connection)
            .build();
}

// Then resolve buckets from the proxy manager
Bucket bucket = proxyManager.builder()
    .build(clientId, () -> BucketConfiguration.builder()
        .addLimit(Bandwidth.classic(20, Refill.greedy(20, Duration.ofMinutes(1))))
        .build());
```

Now all your instances share the same counters. Redis adds a few milliseconds of latency per request, but the accuracy is worth it.

### Spring Cloud Gateway Rate Limiting

If you are already using **Spring Cloud Gateway**, it has built-in rate limiting with the `RequestRateLimiter` filter. It uses Redis under the hood:

```yaml
spring:
  cloud:
    gateway:
      routes:
        - id: api-service
          uri: lb://api-service
          predicates:
            - Path=/api/**
          filters:
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 10
                redis-rate-limiter.burstCapacity: 20
                redis-rate-limiter.requestedTokens: 1
                key-resolver: "#{@userKeyResolver}"
```

```java
@Bean
public KeyResolver userKeyResolver() {
    return exchange -> Mono.just(
        exchange.getRequest().getHeaders()
            .getFirst("X-API-Key")
    );
}
```

This is the fastest path if you already have Gateway in your stack. No custom filter code needed.

### Handling 429 Responses Gracefully

A raw 429 is not helpful to the caller. Always include:

- **`Retry-After`** header -- tells the client exactly when to try again
- **`X-RateLimit-Remaining`** -- so clients can self-throttle before hitting the wall
- **A clear JSON body** explaining the error

On the client side, implement **exponential backoff**. I always tell teams consuming my APIs: if you get a 429, do not retry immediately. Wait, then double the wait on each subsequent retry, capped at 60 seconds.

### Testing Rate Limits

Do not skip this. I test rate limiting with a simple integration test:

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RateLimitTest {

    @Autowired
    private TestRestTemplate restTemplate;

    @Test
    void shouldReturn429WhenRateLimitExceeded() {
        HttpHeaders headers = new HttpHeaders();
        headers.set("X-API-Key", "test-client");

        HttpEntity<Void> entity = new HttpEntity<>(headers);

        // Exhaust the limit
        for (int i = 0; i < 20; i++) {
            ResponseEntity<String> response = restTemplate
                .exchange("/api/users", HttpMethod.GET, entity, String.class);
            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        }

        // Next request should be throttled
        ResponseEntity<String> response = restTemplate
            .exchange("/api/users", HttpMethod.GET, entity, String.class);

        assertThat(response.getStatusCode())
            .isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(response.getHeaders().getFirst("Retry-After"))
            .isNotNull();
    }
}
```

### Conclusion

Rate limiting is not a nice-to-have. It is infrastructure. Every production API I have worked on in the last five years has rate limiting baked in from day one. The cost of adding it is low -- a single interceptor, a Redis instance you probably already have, and a few response headers. The cost of not having it is an outage at 2 AM and an uncomfortable conversation with your VP of Engineering on Monday morning. Protect your APIs. Your future self will thank you.
