const fs = require("fs");
const path = require("path");
const { Marked } = require("marked");
const { markedHighlight } = require("marked-highlight");

const WP_URL = process.env.WP_URL?.replace(/\/$/, "");
const WP_USERNAME = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

if (!WP_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
  console.error("Missing environment variables: WP_URL, WP_USERNAME, WP_APP_PASSWORD");
  process.exit(1);
}

const API_BASE = `${WP_URL}/wp-json/wp/v2`;
const AUTH_HEADER =
  "Basic " + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

// Configure marked for clean HTML output with code language classes
const marked = new Marked(
  markedHighlight({
    emptyLangClass: "",
    langPrefix: "language-",
    highlight(code) {
      // Return raw code - WordPress syntax highlighter plugins handle the rest
      return code;
    },
  })
);

marked.setOptions({
  gfm: true,
  breaks: false,
});

async function wpFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: AUTH_HEADER,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WordPress API error ${res.status}: ${body}`);
  }

  return res.json();
}

async function getExistingPost(slug) {
  const posts = await wpFetch(`/posts?slug=${slug}&status=publish,draft,pending`);
  return posts.length > 0 ? posts[0] : null;
}

async function getOrCreateTag(tagName) {
  // Check if tag exists
  const existing = await wpFetch(`/tags?search=${encodeURIComponent(tagName)}`);
  const match = existing.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
  if (match) return match.id;

  // Create new tag
  const tag = await wpFetch("/tags", {
    method: "POST",
    body: JSON.stringify({ name: tagName }),
  });
  return tag.id;
}

async function getOrCreateCategory(name) {
  const existing = await wpFetch(`/categories?search=${encodeURIComponent(name)}`);
  const match = existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (match) return match.id;

  const cat = await wpFetch("/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return cat.id;
}

async function publishPost(postMeta) {
  const { slug, title, excerpt, date, tags, readTime } = postMeta;

  // Read markdown file
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

  // Build post data
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

  // Check if post already exists
  const existing = await getExistingPost(slug);

  if (existing) {
    // Update existing post
    await wpFetch(`/posts/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(postData),
    });
    console.log(`  Updated: "${title}"`);
  } else {
    // Create new post
    await wpFetch("/posts", {
      method: "POST",
      body: JSON.stringify(postData),
    });
    console.log(`  Published: "${title}"`);
  }
}

async function main() {
  console.log(`\nPublishing to: ${WP_URL}\n`);

  // Read blogs.json
  const blogsPath = path.join(__dirname, "..", "blogs.json");
  const { posts } = JSON.parse(fs.readFileSync(blogsPath, "utf-8"));

  console.log(`Found ${posts.length} posts in blogs.json\n`);

  let success = 0;
  let failed = 0;

  for (const post of posts) {
    try {
      await publishPost(post);
      success++;
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
