# MiniOp AI Clipping

AI-powered video clipping for MiniOp - automatically selects the best moments from videos.

## When to use

Use this skill when analyzing videos to find the best clips - detecting viral moments, selecting by genre, finding specific content, and scoring clip quality.

## Capabilities

- Genre-based clipping (Podcast, Lifestyle, Vlog, Travel, Food, Fitness, Sports, Gaming, etc.)
- Emotion detection for compelling moments
- Visual object detection for key scenes
- Sound analysis for audio highlights
- Virality scoring to predict engagement
- Specific moment finding based on prompts
- Auto-hook detection for attention-grabbing intros

## AI Models Used

- **Whisper large-v3**: Transcription (99+ languages)
- **CLIP ViT-L/14**: Visual understanding
- **FER**: Emotion detection
- **PySceneDetect**: Scene detection
- **SAM**: Object tracking

## Free Tier Services

- Google Colab (15 hrs/week) for AI inference
- Kaggle (30 hrs/week) as fallback
- Lightning AI as second fallback

## Clipping Pipeline

1. **Transcribe**: Generate transcript with Whisper
2. **Analyze**: Run CLIP for visual analysis
3. **Detect**: Find emotions with FER
4. **Score**: Calculate virality score
5. **Select**: Choose best clips based on criteria
6. **Output**: Return clip timestamps and metadata

## Genre-Specific Models

| Genre | Focus |
|-------|-------|
| Podcast | Key insights, debates, funny moments |
| Lifestyle | Aesthetic shots, transformations |
| Travel | Scenic views, adventures |
| Food | Cooking steps, final reveals |
| Fitness | Form highlights, PRs |
| Sports | Goals, plays, reactions |
| Gaming | Clutch moments, reactions |

## Commands

```bash
# Analyze video
node skills/miniop-ai-clipping/analyze.js --input video.mp4 --genre podcast --clips 5

# Find specific moments
node skills/miniop-ai-clipping/find-moments.js --input video.mp4 --prompt "find moments about playoffs"
```
