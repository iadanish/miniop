# MiniOp Social

Social media integration for MiniOp - handles posting, scheduling, and analytics across platforms.

## When to use

Use this skill when publishing clips to social media platforms - scheduling posts, optimizing for each platform, tracking performance, and managing multiple accounts.

## Supported Platforms

| Platform | Features |
|----------|----------|
| YouTube | Shorts, Channel posting |
| TikTok | Feed, Inbox |
| LinkedIn | Personal page, Profile |
| Facebook | Page posting |
| Instagram | Business, Creator |
| X (Twitter) | Profile posting (1 credit per post) |

## Capabilities

- Multi-platform posting
- Post scheduling with timezone support
- Platform-specific optimization
- Title and description generation
- Hashtag recommendations
- Best time to post suggestions
- Analytics tracking
- Multi-account management

## Free Tier Services

- Platform APIs (free tier)
- Supabase for scheduling database
- Cloudflare Workers for API handling
- Redis for queue management

## Posting Pipeline

1. **Prepare**: Optimize video for target platform
2. **Generate**: Create title, description, hashtags
3. **Schedule**: Queue post for optimal time
4. **Post**: Publish to platform via API
5. **Track**: Monitor engagement metrics
6. **Report**: Update analytics dashboard

## Platform Specifications

| Platform | Max Length | Aspect Ratio | Credits |
|----------|-----------|--------------|---------|
| YouTube Shorts | 60s | 9:16 | Free |
| TikTok | 10min | 9:16 | Free |
| LinkedIn | 10min | 1:1, 4:5, 9:16 | Free |
| Facebook | 240min | 1:1, 4:5, 9:16 | Free |
| Instagram | 90s | 1:1, 4:5, 9:16 | Free |
| X | 140s | 16:9, 1:1 | 1 credit |

## Commands

```bash
# Post to single platform
node skills/miniop-social/post.js --video clip.mp4 --platform youtube --title "My Clip"

# Schedule post
node skills/miniop-social/schedule.js --video clip.mp4 --platform tiktok --time "2026-06-20T10:00:00Z"

# Post to multiple platforms
node skills/miniop-social/multi-post.js --video clip.mp4 --platforms "youtube,tiktok,instagram"
```
