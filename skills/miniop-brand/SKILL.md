# MiniOp Brand

Brand template system for MiniOp - manages logos, intros, outros, and brand consistency.

## When to use

Use this skill when applying brand elements to videos - adding logos, creating intros/outros, applying brand colors, and maintaining brand consistency across clips.

## Capabilities

- Logo overlay with customizable position and size
- Intro and outro generation
- Brand color application
- Custom font integration
- CTA (Call-to-Action) overlay
- Brand vocabulary management
- Template saving and loading

## Brand Elements

| Element | Description |
|---------|-------------|
| Logo | PNG/SVG overlay with position control |
| Intro | Animated brand intro (3-5 seconds) |
| Outro | Brand outro with CTA |
| Colors | Brand color palette |
| Fonts | Custom typography |
| Music | Brand audio signature |

## Free Tier Services

- Remotion for brand element rendering
- Cloudflare R2 for storing brand assets
- Supabase for brand template database

## Brand Pipeline

1. **Load**: Retrieve brand template from database
2. **Prepare**: Generate brand elements (logo, intro, outro)
3. **Apply**: Overlay brand elements on video
4. **Sync**: Align with video timing
5. **Render**: Generate final branded video
6. **Export**: Output branded clip

## Template Structure

```json
{
  "name": "My Brand",
  "logo": "logo.png",
  "position": "top-right",
  "size": 150,
  "intro": "intro.mp4",
  "outro": "outro.mp4",
  "colors": {
    "primary": "#FF0000",
    "secondary": "#0000FF"
  },
  "fonts": {
    "heading": "Montserrat",
    "body": "Open Sans"
  }
}
```

## Commands

```bash
# Apply brand template
node skills/miniop-brand/apply.js --input video.mp4 --template my-brand --output branded.mp4

# Create new brand template
node skills/miniop-brand/create.js --name "My Brand" --logo logo.png
```
