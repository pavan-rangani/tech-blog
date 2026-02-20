## Redis Caching Patterns That Scale: A Spring Boot Guide

I've spent a good chunk of my career optimizing Java APIs that were perfectly fine at 100 requests per second but fell over at 1,000. The fix was almost always the same: **stop hitting the database for data that hasn't changed**. Caching sounds simple until you're debugging stale data in production at 2 AM. This post covers the patterns, the pitfalls, and the practical Spring Boot setup I use on every project.

### Why Caching Matters More Than You Think

Here's a scenario I see constantly. Your REST API fetches a user profile. The query joins three tables, takes 45ms, and gets called 500 times per minute. That's 22,500 database round-trips per hour for data that changes maybe twice a day. Add Redis in front of that, and the response drops to 2ms with near-zero database load. **Caching isn't premature optimization -- it's responsible engineering.**

### Spring Boot + Redis Setup

Start with the dependency:

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
```

Configure Redis in `application.yml`:

```yaml
spring:
  data:
    redis:
      host: localhost
      port: 6379
      timeout: 2000ms
      lettuce:
        pool:
          max-active: 16
          max-idle: 8
          min-idle: 4
```

Enable caching and configure the serializer. **Do not skip the serializer config** -- the default JDK serializer is slow and produces unreadable keys:

```java
@Configuration
@EnableCaching
public class RedisConfig {

    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        RedisCacheConfiguration defaultConfig = RedisCacheConfiguration
            .defaultCacheConfig()
            .serializeKeysWith(
                SerializationPair.fromSerializer(new StringRedisSerializer()))
            .serializeValuesWith(
                SerializationPair.fromSerializer(new GenericJackson2JsonRedisSerializer()))
            .entryTtl(Duration.ofMinutes(30))
            .disableCachingNullValues();

        Map<String, RedisCacheConfiguration> cacheConfigs = Map.of(
            "users", defaultConfig.entryTtl(Duration.ofHours(1)),
            "products", defaultConfig.entryTtl(Duration.ofMinutes(15)),
            "sessions", defaultConfig.entryTtl(Duration.ofMinutes(5))
        );

        return RedisCacheManager.builder(connectionFactory)
            .cacheDefaults(defaultConfig)
            .withInitialCacheConfigurations(cacheConfigs)
            .build();
    }
}
```

Notice the per-cache TTL configuration. User profiles change rarely -- give them a longer TTL. Product inventory changes frequently -- keep it short. One-size-fits-all TTLs are a mistake I made early on.

### The Core Annotations

Spring's caching abstraction gives you three annotations that cover 90% of use cases:

| Annotation | Behavior | When to Use |
|---|---|---|
| `@Cacheable` | Returns cached value; calls method on miss | Read-heavy methods |
| `@CacheEvict` | Removes entry from cache | After updates or deletes |
| `@CachePut` | Always calls method, updates cache | When you want fresh data cached |

### Practical Example: A User Service

Here's how I wire caching into a real service:

```java
@Service
@Slf4j
public class UserService {

    private final UserRepository userRepository;

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Cacheable(value = "users", key = "#userId")
    public UserDTO getUserById(Long userId) {
        log.info("Cache MISS for user: {}", userId);
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new UserNotFoundException(userId));
        return toDTO(user);
    }

    @Cacheable(value = "users", key = "'email:' + #email")
    public UserDTO getUserByEmail(String email) {
        log.info("Cache MISS for email: {}", email);
        User user = userRepository.findByEmail(email)
            .orElseThrow(() -> new UserNotFoundException(email));
        return toDTO(user);
    }

    @CacheEvict(value = "users", allEntries = true)
    public UserDTO updateUser(Long userId, UpdateUserRequest request) {
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new UserNotFoundException(userId));
        user.setName(request.getName());
        user.setEmail(request.getEmail());
        return toDTO(userRepository.save(user));
    }

    @Caching(evict = {
        @CacheEvict(value = "users", allEntries = true),
        @CacheEvict(value = "user-lists", allEntries = true)
    })
    public void deleteUser(Long userId) {
        userRepository.deleteById(userId);
    }
}
```

A few things to note:

- **Cache DTOs, not entities.** Caching JPA entities causes lazy loading nightmares and serialization failures. Always map to a plain DTO first.
- **Key design matters.** The key `'email:' + #email` creates a namespaced key so lookups by ID and email don't collide.
- **The log statement** is intentional. In production, I log every cache miss so I can spot patterns -- if a key is constantly missing, the TTL is too short or the eviction is too aggressive.

### Cache-Aside Pattern

The annotations above implement cache-aside automatically, but sometimes you need manual control. Here's the explicit version:

```java
@Service
public class ProductService {

    private final RedisTemplate<String, ProductDTO> redisTemplate;
    private final ProductRepository productRepository;

    private static final String CACHE_PREFIX = "product:";
    private static final Duration CACHE_TTL = Duration.ofMinutes(15);

    public ProductDTO getProduct(Long productId) {
        String key = CACHE_PREFIX + productId;

        // Step 1: Check cache
        ProductDTO cached = redisTemplate.opsForValue().get(key);
        if (cached != null) {
            return cached;
        }

        // Step 2: Cache miss - fetch from DB
        Product product = productRepository.findById(productId)
            .orElseThrow(() -> new ProductNotFoundException(productId));
        ProductDTO dto = toDTO(product);

        // Step 3: Populate cache
        redisTemplate.opsForValue().set(key, dto, CACHE_TTL);

        return dto;
    }
}
```

I use this manual approach when I need conditional caching -- for example, only caching products that are active, or skipping the cache entirely when a request header says `Cache-Control: no-cache`.

### TTL Strategies and Cache Invalidation

The two hardest problems in computer science: cache invalidation and naming things. Here's my practical approach:

- **Short TTL (1-5 min):** Data that changes often -- inventory counts, pricing, session state
- **Medium TTL (15-60 min):** Data that changes occasionally -- user profiles, product details
- **Long TTL (1-24 hours):** Reference data that rarely changes -- categories, country lists, feature flags

**Never set an infinite TTL.** I've seen production systems serve stale data for weeks because someone forgot to evict a cache with no expiry. Always set a TTL as a safety net, even if you have explicit eviction logic.

### Cache Stampede Prevention

Here's a scenario that will ruin your day: a popular cache key expires, and 200 concurrent requests all hit the database simultaneously to rebuild it. This is a **cache stampede**, and it can cascade into a full outage.

The fix is a distributed lock:

```java
public ProductDTO getProductWithLock(Long productId) {
    String key = CACHE_PREFIX + productId;
    String lockKey = "lock:" + key;

    ProductDTO cached = redisTemplate.opsForValue().get(key);
    if (cached != null) {
        return cached;
    }

    // Try to acquire lock
    Boolean acquired = redisTemplate.opsForValue()
        .setIfAbsent(lockKey, "locked", Duration.ofSeconds(10));

    if (Boolean.TRUE.equals(acquired)) {
        try {
            // Double-check after acquiring lock
            cached = redisTemplate.opsForValue().get(key);
            if (cached != null) {
                return cached;
            }

            Product product = productRepository.findById(productId)
                .orElseThrow(() -> new ProductNotFoundException(productId));
            ProductDTO dto = toDTO(product);
            redisTemplate.opsForValue().set(key, dto, CACHE_TTL);
            return dto;
        } finally {
            redisTemplate.delete(lockKey);
        }
    } else {
        // Another thread is rebuilding - wait and retry
        try {
            Thread.sleep(100);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return getProductWithLock(productId);
    }
}
```

The `setIfAbsent` is an atomic Redis operation (SETNX). Only one thread wins the lock, rebuilds the cache, and everyone else waits. The 10-second lock TTL is a safety net in case the lock holder crashes.

### Monitoring Cache Hit Rates

You can't improve what you don't measure. Expose Redis metrics through Spring Actuator:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus
  metrics:
    tags:
      application: order-service
```

Then query the key metrics:

```java
@RestController
@RequestMapping("/api/cache")
public class CacheMetricsController {

    private final RedisTemplate<String, Object> redisTemplate;

    @GetMapping("/stats")
    public Map<String, Object> getCacheStats() {
        Properties info = redisTemplate.getConnectionFactory()
            .getConnection().serverCommands().info("stats");

        return Map.of(
            "keyspace_hits", info.getProperty("keyspace_hits"),
            "keyspace_misses", info.getProperty("keyspace_misses"),
            "hit_rate", calculateHitRate(info),
            "connected_clients", info.getProperty("connected_clients", "N/A")
        );
    }

    private String calculateHitRate(Properties info) {
        long hits = Long.parseLong(info.getProperty("keyspace_hits", "0"));
        long misses = Long.parseLong(info.getProperty("keyspace_misses", "0"));
        long total = hits + misses;
        if (total == 0) return "0%";
        return String.format("%.1f%%", (hits * 100.0) / total);
    }
}
```

A healthy cache hit rate is **above 85%**. If you're below that, your TTLs are too short, your key design is wrong, or you're caching the wrong things.

### Distributed Caching Considerations

When running multiple instances of your service, Redis naturally acts as a shared cache. But keep these in mind:

- **Serialization format:** JSON is readable and debuggable. Use `GenericJackson2JsonRedisSerializer` for development and `Kryo` or `Protobuf` for high-throughput production systems.
- **Key namespacing:** Prefix all keys with the service name (`order-svc:users:42`) to avoid collisions when multiple services share a Redis cluster.
- **Network latency:** Redis calls add ~1-2ms of network overhead. For sub-millisecond needs, consider a local Caffeine cache in front of Redis (L1/L2 caching).
- **Redis cluster mode:** For datasets larger than a single node's memory, use Redis Cluster. Spring Data Redis supports it natively with `spring.data.redis.cluster.nodes`.

### Common Mistakes I've Seen (and Made)

- **Caching mutable objects:** If you cache a JPA entity and something modifies it, the cached version changes too. Always cache immutable DTOs.
- **No TTL:** Every cache entry needs an expiration. "We'll evict it manually" is a promise that will be broken.
- **Over-caching:** Caching everything is as bad as caching nothing. If a query takes 2ms and returns different results for each user, caching it adds complexity with no benefit.
- **Ignoring cache warmup:** After a deployment, all caches are cold. If your app gets heavy traffic immediately, the database takes the full load. Consider a warmup routine for critical data.
- **Not handling Redis downtime:** Redis will go down eventually. Use `@Cacheable` with a try-catch fallback or configure Spring's `CacheErrorHandler` to degrade gracefully to database queries.

```java
@Configuration
public class CacheErrorConfig extends CachingConfigurerSupport {

    @Override
    public CacheErrorHandler errorHandler() {
        return new SimpleCacheErrorHandler() {
            @Override
            public void handleCacheGetError(RuntimeException ex,
                    Cache cache, Object key) {
                log.warn("Cache GET failed for key {}: {}", key, ex.getMessage());
                // Don't rethrow - fall through to the actual method
            }
        };
    }
}
```

### Closing Thoughts

Caching is an art disguised as engineering. The tools are straightforward -- Redis, Spring annotations, TTLs. But the decisions are nuanced. What to cache, for how long, when to invalidate, how to handle failures. Every application is different, and the right caching strategy comes from understanding your data access patterns, not from copying a tutorial. Start with the hot paths, measure everything, and remember: **the best cache is one you've thought carefully about, not one you've sprinkled everywhere.**
