## Docker to Kubernetes: A Java Developer's Production Guide

Nine years into my Java career, I can say this with confidence: **the line between developer and operations has disappeared**. If you're writing Spring Boot services in 2026 and you can't containerize and deploy them, you're shipping half the job. This guide is everything I wish I had when I first moved from "it works on my machine" to "it works in production, at scale, every time."

### Why Java Developers Need Containerization Skills

Here's the reality. Your microservice doesn't exist in isolation. It runs alongside dozens of other services, needs specific JVM settings, connects to databases and message brokers, and has to scale under load. Containers solve the environment consistency problem, and Kubernetes solves the orchestration problem. Knowing both isn't optional anymore -- it's table stakes for senior Java roles.

### Writing Optimized Dockerfiles for Spring Boot

Most tutorials show you a naive Dockerfile. Don't use it in production. Here's what I use instead -- a **multi-stage build** that keeps the final image small and secure:

```dockerfile
# Stage 1: Build
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app
COPY gradle/ gradle/
COPY gradlew build.gradle settings.gradle ./
RUN ./gradlew dependencies --no-daemon
COPY src/ src/
RUN ./gradlew bootJar --no-daemon -x test

# Stage 2: Runtime
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app/build/libs/*.jar app.jar
USER appuser
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
```

Key things happening here:

- **Alpine base** cuts the image from ~400MB to ~180MB
- **JRE, not JDK** in the runtime stage -- you don't need a compiler in production
- **Non-root user** because running as root in containers is a security risk
- **Dependency layer caching** -- the `COPY gradlew` and `RUN dependencies` steps are cached unless your build files change, which saves minutes on rebuilds

### JVM Memory Settings in Containers

This one has bitten me hard. The JVM doesn't always play nice with container memory limits. If your container has a 512MB limit and the JVM tries to allocate its default heap, the OOM killer will terminate your process with no warning.

**Stop using `-Xmx` in containers.** Use percentage-based flags instead:

```dockerfile
ENTRYPOINT ["java", \
  "-XX:MaxRAMPercentage=75.0", \
  "-XX:InitialRAMPercentage=50.0", \
  "-XX:+UseG1GC", \
  "-XX:+UseContainerSupport", \
  "-jar", "app.jar"]
```

`-XX:MaxRAMPercentage=75.0` tells the JVM to use up to 75% of the container's memory limit. The remaining 25% is for non-heap memory, thread stacks, and OS overhead. This scales automatically -- whether your container has 512MB or 4GB.

### Docker Compose for Local Development

Before jumping into Kubernetes, get your local development workflow right with Docker Compose:

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      - SPRING_PROFILES_ACTIVE=local
      - SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/myapp
      - SPRING_REDIS_HOST=redis
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_started

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: secret
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U admin -d myapp"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

One `docker compose up` and your entire stack is running. Every developer on the team gets an identical environment. No more "which version of Postgres are you running?" conversations.

### Kubernetes Basics: The Mental Model

If Docker is a shipping container, Kubernetes is the port authority. Here's the hierarchy that matters:

| Concept | What It Does | Java Analogy |
|---|---|---|
| **Pod** | Runs one or more containers | A single JVM process |
| **Deployment** | Manages pod replicas and updates | A managed thread pool |
| **Service** | Stable network endpoint for pods | A load balancer / DNS entry |
| **ConfigMap** | External configuration | application.yml but outside the jar |
| **Secret** | Sensitive configuration | Encrypted credentials |

### Deploying a Spring Boot App to Kubernetes

Here's a production-grade deployment manifest. I'll break down why each section matters:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  labels:
    app: order-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
  template:
    metadata:
      labels:
        app: order-service
    spec:
      containers:
        - name: order-service
          image: registry.example.com/order-service:1.4.2
          ports:
            - containerPort: 8080
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          envFrom:
            - configMapRef:
                name: order-service-config
            - secretRef:
                name: order-service-secrets
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: order-service
spec:
  selector:
    app: order-service
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
```

### Health Checks with Spring Actuator

Kubernetes probes map directly to Spring Boot Actuator's health groups. Add this to your `application.yml`:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      probes:
        enabled: true
      show-details: always
  health:
    livenessState:
      enabled: true
    readinessState:
      enabled: true
```

- **Liveness probe** answers: "Is the process stuck?" If it fails, Kubernetes restarts the pod.
- **Readiness probe** answers: "Can this pod handle traffic?" If it fails, the pod is removed from the Service's load balancer.

The `initialDelaySeconds` is critical for Java apps. Spring Boot takes time to start -- if your probe fires before the context is ready, Kubernetes will kill the pod in a restart loop.

### ConfigMaps and Secrets

Externalize your Spring config properly:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: order-service-config
data:
  SPRING_DATASOURCE_URL: "jdbc:postgresql://postgres-svc:5432/orders"
  SPRING_REDIS_HOST: "redis-svc"
  SERVER_PORT: "8080"
---
apiVersion: v1
kind: Secret
metadata:
  name: order-service-secrets
type: Opaque
stringData:
  SPRING_DATASOURCE_USERNAME: "order_svc"
  SPRING_DATASOURCE_PASSWORD: "encrypted-password-here"
  API_SECRET_KEY: "my-secret-key"
```

Spring Boot automatically maps environment variables to properties. `SPRING_DATASOURCE_URL` becomes `spring.datasource.url`. No code changes needed.

### Horizontal Pod Autoscaler

Scaling manually is for emergencies. Set up autoscaling from day one:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

This scales between 2 and 10 pods based on CPU and memory utilization. For Java apps, I recommend keeping `minReplicas` at 2 or higher -- JVM cold starts are slow, and you don't want zero pods when traffic arrives.

### Common Pitfalls I've Learned the Hard Way

- **JVM ignoring container limits:** On older JDK versions (pre-10), the JVM reads the host's memory, not the container's. Always use JDK 17+ and verify with `-XX:+UseContainerSupport`.
- **Fat images:** A naive Dockerfile with a full JDK can be 600MB+. Use multi-stage builds and JRE-only runtime images. Your CI/CD pipeline and node pull times will thank you.
- **No resource requests/limits:** Without them, a single pod can starve the entire node. Always set both.
- **Hardcoded config:** If a database URL is in your `application.yml` instead of a ConfigMap, you've made deployment environment-specific. Externalize everything that changes between environments.
- **Ignoring graceful shutdown:** Add `server.shutdown=graceful` and set `terminationGracePeriodSeconds` in your pod spec. Otherwise, in-flight requests get killed during deployments.

### Closing Thoughts

DevOps is a developer skill now. I resisted this for years, thinking infrastructure was "someone else's problem." But the teams that ship fastest are the ones where developers own the full lifecycle -- from writing the code to defining how it runs in production. Docker and Kubernetes aren't just ops tools. They're how modern Java applications are built, tested, and delivered. The investment pays off every single deployment.
