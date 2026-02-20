Building production-ready Spring Boot applications requires more than just getting your code to work. After years of building enterprise systems, here are the practices that consistently separate robust applications from fragile ones.

## Profile-Based Configuration

One of the most powerful features in Spring Boot is its profile system. Instead of maintaining separate configuration files for each environment, leverage profiles to keep your configuration clean and manageable.

```java
// application.yml
spring:
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:dev}

---
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
```

**Key principle**: Never hardcode environment-specific values. Use environment variables with sensible defaults for local development.

## Actuator and Health Checks

Spring Boot Actuator is non-negotiable for production. Configure meaningful health indicators that reflect your application's actual readiness.

```java
@Component
public class DatabaseHealthIndicator implements HealthIndicator {

    private final JdbcTemplate jdbcTemplate;

    @Override
    public Health health() {
        try {
            jdbcTemplate.queryForObject("SELECT 1", Integer.class);
            return Health.up()
                .withDetail("database", "reachable")
                .build();
        } catch (Exception e) {
            return Health.down()
                .withDetail("error", e.getMessage())
                .build();
        }
    }
}
```

Expose only what's necessary — `/actuator/health` and `/actuator/info` for external monitoring, keep detailed endpoints behind authentication.

## Structured Error Handling

A global exception handler prevents stack traces from leaking to clients and ensures consistent error responses across your API.

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ResourceNotFoundException.class)
    public ResponseEntity<ApiError> handleNotFound(ResourceNotFoundException ex) {
        ApiError error = new ApiError(
            HttpStatus.NOT_FOUND.value(),
            ex.getMessage(),
            LocalDateTime.now()
        );
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiError> handleValidation(MethodArgumentNotValidException ex) {
        List<String> details = ex.getBindingResult()
            .getFieldErrors()
            .stream()
            .map(e -> e.getField() + ": " + e.getDefaultMessage())
            .collect(Collectors.toList());

        ApiError error = new ApiError(400, "Validation failed", details);
        return ResponseEntity.badRequest().body(error);
    }
}
```

## Connection Pool Tuning

HikariCP is Spring Boot's default connection pool, but its defaults aren't always optimal. Size your pool based on your workload, not arbitrary numbers.

A good starting formula: **connections = (core_count * 2) + effective_spindle_count**

For most applications with SSDs, 10-15 connections handle significant load. Monitor `hikaricp_connections_active` and `hikaricp_connections_pending` metrics to fine-tune.

```yaml
spring:
  datasource:
    hikari:
      maximum-pool-size: 15
      minimum-idle: 5
      connection-timeout: 30000
      idle-timeout: 600000
      max-lifetime: 1800000
```

## Testing Strategy

Structure your tests in layers. Unit tests for business logic, integration tests for data layer, and a few end-to-end tests for critical paths.

```java
@DataJpaTest
class UserRepositoryTest {

    @Autowired
    private UserRepository userRepository;

    @Test
    void shouldFindActiveUsersByRole() {
        // Given
        userRepository.save(new User("Pavan", Role.ADMIN, Status.ACTIVE));
        userRepository.save(new User("Test", Role.USER, Status.INACTIVE));

        // When
        List<User> admins = userRepository.findByRoleAndStatus(
            Role.ADMIN, Status.ACTIVE
        );

        // Then
        assertThat(admins).hasSize(1);
        assertThat(admins.get(0).getName()).isEqualTo("Pavan");
    }
}
```

Use `@DataJpaTest` for repository tests (fast, uses embedded DB), `@WebMvcTest` for controller tests, and `@SpringBootTest` sparingly for full integration tests.

## Logging Best Practices

Structured logging with correlation IDs makes debugging distributed systems possible. Use MDC (Mapped Diagnostic Context) to thread request context through your logs.

```java
@Component
public class CorrelationIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response, FilterChain chain) {
        String correlationId = request.getHeader("X-Correlation-Id");
        if (correlationId == null) {
            correlationId = UUID.randomUUID().toString();
        }
        MDC.put("correlationId", correlationId);
        response.setHeader("X-Correlation-Id", correlationId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.clear();
        }
    }
}
```

## Final Thoughts

Production readiness isn't a checklist you complete once — it's a discipline you maintain. Start with these practices from day one, and your future self will thank you when that 3 AM alert comes in and your structured logs, health checks, and clean error handling make the difference between a 5-minute fix and a 5-hour debugging session.

The best Spring Boot applications I've worked on share one trait: they're boring in production. And boring is exactly what you want.
