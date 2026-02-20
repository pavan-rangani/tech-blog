## Building Intelligent AI Applications with Spring AI

A year ago, if you wanted to integrate AI into a Java application, you were stitching together REST calls to OpenAI, manually parsing JSON responses, and writing boilerplate that had nothing to do with your actual business logic. Spring AI changes that completely. It brings the same opinionated, convention-over-configuration approach that made Spring Boot successful — but for AI-powered applications.

I have been building with Spring AI in production for the past several months, and I want to walk through what it actually looks like to build intelligent features with it.

### Getting Started with Spring AI

Add the Spring AI dependency for your preferred model provider. Spring AI supports OpenAI, Anthropic, Ollama, Azure OpenAI, and others through a unified API.

```xml
<dependency>
    <groupId>org.springframework.ai</groupId>
    <artifactId>spring-ai-openai-spring-boot-starter</artifactId>
</dependency>
```

Configure your API key:

```yaml
# application.yml
spring:
  ai:
    openai:
      api-key: ${OPENAI_API_KEY}
      chat:
        options:
          model: gpt-4o
          temperature: 0.7
```

Switching providers is straightforward. Replace the starter dependency and update the configuration — your application code stays the same thanks to the `ChatClient` abstraction.

### Using ChatClient

`ChatClient` is the core interface. Think of it as the `RestTemplate` of AI — a clean, fluent API for interacting with language models.

```java
@Service
public class AssistantService {

    private final ChatClient chatClient;

    public AssistantService(ChatClient.Builder builder) {
        this.chatClient = builder
            .defaultSystem("You are a helpful technical assistant for a software company. " +
                "Answer questions concisely and accurately.")
            .build();
    }

    public String askQuestion(String userQuestion) {
        return chatClient.prompt()
            .user(userQuestion)
            .call()
            .content();
    }

    public TechRecommendation getRecommendation(String requirements) {
        return chatClient.prompt()
            .user("Analyze these requirements and recommend a tech stack: " + requirements)
            .call()
            .entity(TechRecommendation.class);  // Automatic deserialization
    }
}
```

The `.entity()` method is particularly powerful — Spring AI handles the prompt engineering needed to get structured JSON output and deserializes it directly into your Java object. No manual parsing required.

### Prompt Templates

Hardcoding prompts in Java strings is messy. Spring AI supports prompt templates with variable substitution:

```java
@Service
public class CodeReviewService {

    private final ChatClient chatClient;

    @Value("classpath:prompts/code-review.st")
    private Resource codeReviewPrompt;

    public CodeReviewResult reviewCode(String code, String language) {
        return chatClient.prompt()
            .user(u -> u
                .text(codeReviewPrompt)
                .param("code", code)
                .param("language", language))
            .call()
            .entity(CodeReviewResult.class);
    }
}
```

```
// src/main/resources/prompts/code-review.st
Review the following {language} code for:
- Security vulnerabilities
- Performance issues
- Best practice violations

Code:
```{language}
{code}
```

Return a structured analysis with severity levels (HIGH, MEDIUM, LOW) for each finding.
```

Keeping prompts in resource files makes them version-controlled, testable, and easy to iterate on without recompiling.

### RAG: Retrieval-Augmented Generation

This is where Spring AI gets truly interesting for enterprise applications. RAG lets you ground AI responses in your own data — product documentation, internal wikis, customer records — instead of relying solely on the model's training data.

The pattern is straightforward:

1. **Ingest** your documents into a vector store
2. **Retrieve** relevant chunks based on the user's query
3. **Generate** a response using those chunks as context

```java
@Service
public class DocumentIngestionService {

    private final VectorStore vectorStore;

    public void ingestDocuments(List<Resource> documents) {
        TokenTextSplitter splitter = new TokenTextSplitter(800, 350, 5, 10000, true);

        for (Resource doc : documents) {
            List<Document> chunks = new TikaDocumentReader(doc).get();
            List<Document> splitDocs = splitter.apply(chunks);
            vectorStore.add(splitDocs);
        }
    }
}
```

### Vector Store with PgVector

If you are already running PostgreSQL, PgVector is the easiest path to a production vector store. No new infrastructure to manage.

```yaml
spring:
  ai:
    vectorstore:
      pgvector:
        index-type: HNSW
        distance-type: COSINE_DISTANCE
        dimensions: 1536
  datasource:
    url: jdbc:postgresql://localhost:5432/myapp
```

```java
@Configuration
public class VectorStoreConfig {

    @Bean
    public VectorStore vectorStore(JdbcTemplate jdbcTemplate, EmbeddingModel embeddingModel) {
        return new PgVectorStore(jdbcTemplate, embeddingModel,
            PgVectorStore.PgVectorStoreConfig.builder()
                .withSchemaName("public")
                .withTableName("vector_store")
                .withDimensions(1536)
                .build());
    }
}
```

### Building an AI-Powered Q&A Service

Here is a complete Q&A service that combines RAG with ChatClient. This is the pattern I use in production for internal knowledge base queries.

```java
@Service
public class QnAService {

    private final ChatClient chatClient;
    private final VectorStore vectorStore;

    public QnAService(ChatClient.Builder builder, VectorStore vectorStore) {
        this.vectorStore = vectorStore;
        this.chatClient = builder
            .defaultSystem("Answer questions based on the provided context. " +
                "If the context doesn't contain enough information, say so clearly.")
            .defaultAdvisors(new QuestionAnswerAdvisor(vectorStore,
                SearchRequest.defaults().withTopK(5).withSimilarityThreshold(0.7)))
            .build();
    }

    public Answer askAboutDocs(String question) {
        String response = chatClient.prompt()
            .user(question)
            .call()
            .content();

        return new Answer(question, response);
    }
}
```

The `QuestionAnswerAdvisor` automatically retrieves relevant documents from the vector store and injects them into the prompt context. You write a simple method call, and Spring AI handles the retrieval, context assembly, and generation pipeline.

### Function Calling / Tool Use

Function calling lets the AI model invoke your Java methods when it needs real-time data or to perform actions. This is where AI goes from a text generator to an actual agent.

```java
@Service
public class WeatherAiService {

    private final ChatClient chatClient;

    public WeatherAiService(ChatClient.Builder builder) {
        this.chatClient = builder
            .defaultFunctions("currentWeather", "weatherForecast")
            .build();
    }

    @Bean
    @Description("Get current weather for a given city")
    public Function<WeatherRequest, WeatherResponse> currentWeather() {
        return request -> weatherApiClient.getCurrentWeather(request.city());
    }

    @Bean
    @Description("Get 5-day weather forecast for a given city")
    public Function<ForecastRequest, ForecastResponse> weatherForecast() {
        return request -> weatherApiClient.getForecast(request.city(), request.days());
    }

    public String chat(String userMessage) {
        return chatClient.prompt()
            .user(userMessage)
            .call()
            .content();
        // When the user asks "What's the weather in Mumbai?",
        // the model automatically calls currentWeather("Mumbai")
    }
}
```

The model decides **when** to call your functions based on the user's query. You declare the tools, describe what they do, and the framework handles the orchestration.

### Error Handling and Rate Limiting

AI APIs fail. They rate-limit you. They time out. Production code must handle all of this gracefully.

```java
@Service
public class ResilientAiService {

    private final ChatClient chatClient;
    private final RateLimiter rateLimiter;

    public ResilientAiService(ChatClient.Builder builder) {
        this.chatClient = builder.build();
        this.rateLimiter = RateLimiter.create(10.0); // 10 requests/second
    }

    public String generateResponse(String prompt) {
        rateLimiter.acquire();

        try {
            return chatClient.prompt()
                .user(prompt)
                .call()
                .content();
        } catch (NonTransientAiException ex) {
            // Invalid request, bad API key, content policy violation
            log.error("Non-retryable AI error: {}", ex.getMessage());
            throw new AiServiceException("Request failed: " + ex.getMessage(), ex);
        } catch (TransientAiException ex) {
            // Rate limit, timeout, server error — retry
            log.warn("Transient AI error, retrying: {}", ex.getMessage());
            return retryWithBackoff(prompt, 3);
        }
    }

    private String retryWithBackoff(String prompt, int maxRetries) {
        for (int i = 1; i <= maxRetries; i++) {
            try {
                Thread.sleep(Duration.ofSeconds((long) Math.pow(2, i)));
                return chatClient.prompt().user(prompt).call().content();
            } catch (TransientAiException ex) {
                if (i == maxRetries) throw new AiServiceException("Max retries exceeded", ex);
            }
        }
        throw new AiServiceException("Retry logic exhausted");
    }
}
```

### Production Considerations

Running AI features in production is not just about making API calls. Here is what I have learned the hard way:

**Cost control** is critical. A single GPT-4 call can cost $0.03-0.10. Multiply that by thousands of users and you have a real budget problem. Cache aggressively — identical or near-identical queries should hit a cache, not the API.

```java
@Cacheable(value = "ai-responses", key = "#prompt.hashCode()")
public String getCachedResponse(String prompt) {
    return chatClient.prompt().user(prompt).call().content();
}
```

**Latency** varies wildly. AI responses can take 500ms to 30+ seconds depending on the model, prompt length, and provider load. Use async processing with virtual threads, set aggressive timeouts, and show streaming responses to users when possible.

**Observability** matters more than usual. Log every prompt, response, token count, and latency. You need this data to optimize costs, detect prompt injection attempts, and debug quality issues.

| Concern | Strategy |
|---------|----------|
| Cost | Cache responses, use cheaper models for simple tasks, set budget alerts |
| Latency | Stream responses, use async processing, set timeouts |
| Quality | Version prompts, A/B test, log and review outputs |
| Security | Sanitize inputs, validate outputs, never trust model responses blindly |
| Reliability | Retry with backoff, circuit breakers, fallback responses |

### Final Thoughts

Spring AI makes the Java ecosystem a first-class citizen in the AI application space. You do not need to switch to Python to build intelligent features. The same dependency injection, the same testing patterns, the same deployment pipelines you already know — they all apply.

What excites me most is not the technology itself but what it enables. Java developers can now build RAG-powered knowledge bases, AI agents with tool use, and intelligent automation without leaving their ecosystem. The learning curve is not "learn a new language" — it is "learn a new Spring module."

We are at the beginning of a shift where every enterprise application will have some AI capability. Spring AI ensures that Java developers are not left behind. If you have been watching the AI wave from the sidelines thinking it is a Python-only game, it is time to jump in. The water is fine.
