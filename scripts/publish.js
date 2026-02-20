const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { Marked } = require("marked");
const { markedHighlight } = require("marked-highlight");

let WP_URL = process.env.WP_URL?.trim()?.replace(/\/$/, "") || "";
const WP_USERNAME = process.env.WP_USERNAME?.trim();
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD?.trim();

if (!WP_URL || !WP_USERNAME || !WP_APP_PASSWORD) {
  console.error("Missing: WP_URL, WP_USERNAME, WP_APP_PASSWORD");
  process.exit(1);
}

if (!WP_URL.startsWith("http")) WP_URL = "https://" + WP_URL;

const API_BASE = `${WP_URL}/wp-json/wp/v2`;
console.log(`Target: ${new URL(API_BASE).hostname}`);
const AUTH_HEADER =
  "Basic " +
  Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString("base64");

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

// --- HTTP helpers ---

function wpRequest(endpoint, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${endpoint}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: {
          Authorization: AUTH_HEADER,
          "Content-Type": "application/json",
          "User-Agent": "TechBlog-Publisher/1.0",
        },
      },
      (res) => {
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
                `API ${res.statusCode} ${method} ${endpoint}: ${data.substring(0, 200)}`
              )
            );
          }
        });
      }
    );
    req.on("error", (e) =>
      reject(new Error(`Network ${method} ${endpoint}: ${e.code} ${e.message}`))
    );
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Timeout ${method} ${endpoint}`));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function downloadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const doRequest = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const mod = url.startsWith("https") ? https : http;
      mod
        .get(url, { headers: { "User-Agent": "TechBlog-Publisher/1.0" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doRequest(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Image download failed: ${res.statusCode}`));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: res.headers["content-type"] || "image/jpeg",
            });
          });
        })
        .on("error", reject);
    };
    doRequest(imageUrl);
  });
}

function uploadMedia(imageBuffer, filename, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}/media`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: AUTH_HEADER,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "User-Agent": "TechBlog-Publisher/1.0",
        },
      },
      (res) => {
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
              new Error(`Media upload ${res.statusCode}: ${data.substring(0, 200)}`)
            );
          }
        });
      }
    );
    req.on("error", (e) => reject(new Error(`Media upload error: ${e.message}`)));
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("Media upload timeout"));
    });
    req.write(imageBuffer);
    req.end();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- WordPress helpers ---

async function getExistingPost(slug) {
  const posts = await wpRequest(`/posts?slug=${slug}`);
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

async function setFeaturedImage(slug, imageUrl) {
  if (!imageUrl) return null;

  // Check if image already exists in media library
  const filename = `${slug}-featured.jpg`;
  try {
    const existing = await wpRequest(
      `/media?search=${encodeURIComponent(slug)}&per_page=5`
    );
    const match = existing.find(
      (m) => m.slug && m.slug.includes(slug)
    );
    if (match) return match.id;
  } catch {
    // Continue to upload
  }

  console.log(`    Downloading image for ${slug}...`);
  const { buffer, contentType } = await downloadImage(imageUrl);
  console.log(`    Uploading to WordPress (${(buffer.length / 1024).toFixed(0)}KB)...`);
  const media = await uploadMedia(buffer, filename, contentType);
  return media.id;
}

// --- Main publish ---

async function publishPost(postMeta) {
  const { slug, title, excerpt, date, tags, featuredImage } = postMeta;

  const mdPath = path.join(__dirname, "..", "posts", `${slug}.md`);
  if (!fs.existsSync(mdPath)) {
    console.warn(`  Skipping "${slug}" - file not found`);
    return;
  }

  const markdown = fs.readFileSync(mdPath, "utf-8");
  const htmlContent = marked.parse(markdown);

  // Tags (skip silently if no permission)
  const tagIds = [];
  for (const tag of tags || []) {
    try {
      tagIds.push(await getOrCreateTag(tag));
      await delay(200);
    } catch {}
  }

  // Category
  let categoryIds = [];
  try {
    categoryIds.push(await getOrCreateCategory("Blog"));
  } catch {}

  // Featured image
  let featuredMediaId = null;
  try {
    featuredMediaId = await setFeaturedImage(slug, featuredImage);
  } catch (e) {
    console.warn(`    Image failed: ${e.message}`);
  }

  const postData = {
    title,
    slug,
    content: htmlContent,
    excerpt,
    status: "publish",
    date: new Date(date).toISOString(),
  };

  if (tagIds.length > 0) postData.tags = tagIds;
  if (categoryIds.length > 0) postData.categories = categoryIds;
  if (featuredMediaId) postData.featured_media = featuredMediaId;

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
  console.log("Testing API...");
  try {
    await wpRequest("/posts?per_page=1");
    console.log("Connected OK\n");
  } catch (e) {
    console.error(`API error: ${e.message}`);
    process.exit(1);
  }

  const { posts } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "blogs.json"), "utf-8")
  );
  console.log(`Found ${posts.length} posts\n`);

  let success = 0,
    failed = 0;

  for (const post of posts) {
    try {
      await publishPost(post);
      success++;
      await delay(500);
    } catch (e) {
      console.error(`  Failed: "${post.title}" - ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone! ${success} published, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
