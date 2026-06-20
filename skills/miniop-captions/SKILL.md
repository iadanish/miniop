# MiniOp Captions

AI-powered caption system for MiniOp - generates animated captions with multiple presets.

## When to use

Use this skill when adding captions to videos - generating subtitles, applying caption styles, customizing appearance, and syncing with audio.

## Capabilities

- Multi-language transcription (99+ languages via Whisper)
- 10+ caption presets (Beasty, Mozi, Karaoke, Glitch Infinite, Deep Diver, Pod P, Popline, Seamless Bounce, etc.)
- Animated caption styles
- Speaker-based caption colors
- Custom font support
- Auto emoji and keyword highlights
- Auto censor curse words

## Caption Presets

| Preset | Style |
|--------|-------|
| Beasty | Bold, impactful |
| Mozi | Clean, modern |
| Karaoke | Word-by-word highlight |
| Glitch Infinite | Glitch effect |
| Deep Diver | Subtle, professional |
| Pod P | Podcast style |
| Popline | Pop art inspired |
| Seamless Bounce | Bouncy animation |

## Free Tier Services

- Remotion for caption rendering
- Whisper for transcription
- Cloudflare R2 for storing caption files

## Caption Pipeline

1. **Transcribe**: Generate transcript with Whisper
2. **Analyze**: Detect speakers, emotions, keywords
3. **Style**: Apply selected caption preset
4. **Render**: Generate caption overlay with Remotion
5. **Sync**: Align captions with audio
6. **Export**: Burn captions into video

## Customization Options

- Font family and size
- Color scheme
- Position (top, bottom, center)
- Animation speed
- Background opacity
- Shadow effects

## Commands

```bash
# Generate captions
node skills/miniop-captions/generate.js --input video.mp4 --preset beasty --language en

# Apply custom captions
node skills/miniop-captions/apply.js --input video.mp4 --captions captions.json --style custom
```
