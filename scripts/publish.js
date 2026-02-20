const fs = require("fs");
const path = require("path");
const https = require("https");
const { Marked } = require("marked");
const { markedHighlight } = require("marked-highlight");

const WP_URL = process.env.WP_URL?.replace(/\/$/, "");
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

if (!WP_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
  console.error(
    "Missing environment variables: WP_URL, WP_USERNAME, WP_APP_PASSWORD"
  );
  process.exit(1);
}

const API_BASE = `${WP_URL}/wp-json/wp/v2`;
const AUTH_HEADER =
  "Basic " +
  Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

// Configure marked
const marked = new Marked(
  markedHighlight({
    emptyLangClass: "",
    langPrefix: "language-",
    highlight(code) {
      return code;
    },
  })
);

marked.setOptions({ gfm: true, breaks: false });

// Use Node.js https module instead of fetch for better compatibility
function wpRequest(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${endpoint}`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: AUTH_HEADER,
        "Content-Type": "application/json",
        "User-Agent": "TechBlog-Publisher/1.0",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          reject(
            new Error(
              `API ${res.statusCode} on ${method} ${endpoint}: ${data.substring(0, 200)}`
            )
          );
        }
      });
    });

    req.on("error", (e) => {
      reject(new Error(`Network error on ${method} ${endpoint}: ${e.message}`));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Timeout on ${method} ${endpoint}`));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Add delay between requests to avoid rate limiting
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getExistingPost(slug) {
  const posts = await wpRequest(
    `/posts?slug=${slug}&status=publish,draft,pending`
  );
  return posts.length > 0 ? posts[0] : null;
}

async function getOrCreateTag(tagName) {
  const existing = await wpRequest(
    `/tags?search=${encodeURIComponent(tagName)}`
  );
  const match = existing.find(
    (t) => t.name.toLowerCase() === tagName.toLowerCase()
  );
  if (match) return match.id;

  await delay(300);
  const tag = await wpRequest("/tags", "POST", { name: tagName });
  return tag.id;
}

async function getOrCreateCategory(name) {
  const existing = await wpRequest(
    `/categories?search=${encodeURIComponent(name)}`
  );
  const match = existing.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
  if (match) return match.id;

  await delay(300);
  const cat = await wpRequest("/categories", "POST", { name });
  return cat.id;
}

async function publishPost(postMeta) {
  const { slug, title, excerpt, date, tags } = postMeta;

  const mdPath = path.join(__dirname, "..", "posts", `${slug}.md`);
  if (!fs.existsSync(mdPath)) {
    console.warn(`  Skipping "${slug}" - markdown file not found`);
    return;
  }

  const markdown = fs.readFileSync(mdPath, "utf-8");
  const htmlContent = marked.parse(markdown);

  // Resolve tag IDs
  const tagIds = [];
  for (const tag of tags || []) {
    try {
      const tagId = await getOrCreateTag(tag);
      tagIds.push(tagId);
      await delay(200);
    } catch (e) {
      console.warn(`  Warning: Could not create tag "${tag}": ${e.message}`);
    }
  }

  // Get or create "Blog" category
  let categoryIds = [];
  try {
    const blogCatId = await getOrCreateCategory("Blog");
    categoryIds.push(blogCatId);
  } catch (e) {
    console.warn(`  Warning: Could not get/create category: ${e.message}`);
  }

  const postData = {
    title,
    slug,
    content: htmlContent,
    excerpt,
    status: "publish",
    date: new Date(date).toISOString(),
    tags: tagIds,
    categories: categoryIds,
  };

  const existing = await getExistingPost(slug);

  if (existing) {
    await wpRequest(`/posts/${existing.id}`, "PUT", postData);
    console.log(`  Updated: "${title}"`);
  } else {
    await wpRequest("/posts", "POST", postData);
    console.log(`  Published: "${title}"`);
  }
}

async function main() {
  console.log(`\nPublishing to: ${WP_URL}`);

  // Test connectivity first
  console.log("Testing API connectivity...");
  try {
    await wpRequest("/posts?per_page=1");
    console.log("API connection OK\n");
  } catch (e) {
    console.error(`Cannot reach WordPress API: ${e.message}`);
    console.error(
      "Check WP_URL, WP_USERNAME, and WP_APP_PASSWORD secrets are correct."
    );
    process.exit(1);
  }

  const blogsPath = path.join(__dirname, "..", "blogs.json");
  const { posts } = JSON.parse(fs.readFileSync(blogsPath, "utf-8"));

  console.log(`Found ${posts.length} posts in blogs.json\n`);

  let success = 0;
  let failed = 0;

  for (const post of posts) {
    try {
      await publishPost(post);
      success++;
      await delay(500); // pause between posts
    } catch (e) {
      console.error(`  Failed: "${post.title}" - ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone! ${success} published, ${failed} failed.\n`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
