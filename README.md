# Tech Blog Content

Blog content for [pavanrangani.com](https://pavanrangani.com). The portfolio site fetches posts from this repo at runtime — no rebuild needed.

## How to Add a New Blog Post

1. Create a new `.md` file in the `posts/` folder (use the slug as filename, e.g. `my-new-post.md`)
2. Edit `blogs.json` and add an entry:

```json
{
  "slug": "my-new-post",
  "title": "My New Post Title",
  "excerpt": "A short description of the post...",
  "date": "2025-03-01",
  "author": "Pavan Rangani",
  "tags": ["Tag1", "Tag2"],
  "readTime": "8 min",
  "gradient": "from-cyan-500/20 to-blue-500/10"
}
```

3. Commit — the site picks up changes automatically.

## Available Gradients for Cards

- `from-cyan-500/20 to-blue-500/10` (cyan-blue)
- `from-blue-500/20 to-indigo-500/10` (blue-indigo)
- `from-emerald-500/20 to-cyan-500/10` (green-cyan)
- `from-indigo-500/20 to-purple-500/10` (indigo-purple)
- `from-purple-500/20 to-rose-500/10` (purple-rose)

## Structure

```
blogs.json          → Blog metadata index
posts/
  ├── post-slug.md  → Full blog post in Markdown
  └── ...
```
