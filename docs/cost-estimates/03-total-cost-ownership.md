# Total Cost of Ownership

This document provides the complete cost picture for running MiniOp — combining infrastructure, API costs, development time, maintenance overhead, and hidden costs into a single TCO model. Use this to make build-vs-buy decisions and budget accurately.

---

## TCO Model Overview

Total Cost of Ownership = Infrastructure + APIs + Development Time + Maintenance + Hidden Costs

We analyze two scenarios:
- **Solo Developer / Side Project** (200–500 clips/month)
- **Small Team / Startup** (3,000+ clips/month)

---

## Scenario 1: Solo Developer / Side Project

### Monthly Recurring Costs

| Category | Service | Monthly Cost |
|----------|---------|-------------|
| **Compute** | Google Colab (free) | $0.00 |
| | Kaggle (free) | $0.00 |
| **Storage** | Cloudflare R2 (10 GB) | $0.15 |
| **Frontend** | Vercel Hobby | $0.00 |
| **Backend** | Supabase Free | $0.00 |
| **Edge** | Cloudflare Workers Free | $0.00 |
| **APIs** | Resend Free | $0.00 |
| | Upstash Redis Free | $0.00 |
| **Domain** | .com domain | $1.00 |
| **Total Monthly** | | **$1.15** |

**Annual recurring: ~$13.80**

### One-Time / Annual Costs

| Item | Cost | Frequency |
|------|------|-----------|
| Domain registration | $12.00 | Annual |
| SSL certificate | $0.00 | Auto (Cloudflare) |
| GitHub repository | $0.00 | Free for public |
| Initial model downloads | $0.00 | Cached in Colab |
| **Total One-Time** | **$12.00** | **Annual** |

### Development Time Cost

This is where TCO diverges from "monthly bill." Your time has value.

| Task | Hours | Frequency | Notes |
|------|-------|-----------|-------|
| Initial setup | 20–40 | Once | Colab notebooks, Supabase schema, Vercel deploy |
| Monthly maintenance | 4–8 | Monthly | Bug fixes, dependency updates |
| Feature development | 10–20 | Monthly | New capabilities |
| Colab session management | 2–4 | Monthly | Reconnecting, environment setup |
| **Total (first year)** | | | **~200–350 hours** |

At a conservative $50/hour opportunity cost:

| Metric | Value |
|--------|-------|
| Year 1 development time | 200–350 hours |
| Year 1 opportunity cost | $10,000–$17,500 |
| Year 2+ maintenance | 50–100 hours/year |
| Year 2+ opportunity cost | $2,500–$5,000/year |

### Solo Developer TCO Summary

| Component | Year 1 | Year 2 | Year 3 |
|-----------|--------|--------|--------|
| Infrastructure + APIs | $13.80 | $13.80 | $13.80 |
| Development time | $10,000–$17,500 | $2,500–$5,000 | $2,500–$5,000 |
| **Total TCO** | **$10,014–$17,514** | **$2,514–$5,014** | **$2,514–$5,014** |

**Cost per clip (Year 1, 500 clips/month): $1.67–$2.92**
**Cost per clip (Year 2+, 500 clips/month): $0.42–$0.84**

---

## Scenario 2: Small Team / Startup (3,000+ clips/month)

### Monthly Recurring Costs

| Category | Service | Monthly Cost |
|----------|---------|-------------|
| **Compute** | Colab Pro | $9.99 |
| | RunPod Persistent Pod | $53.00 |
| **Storage** | Cloudflare R2 (100 GB) | $1.52 |
| **Frontend** | Vercel Pro | $20.00 ($20/month per member, 1 seat) |
| **Backend** | Supabase Pro | $25.00 |
| **Edge** | Cloudflare Workers Paid | $5.00 |
| **APIs** | GPT-4o-mini (titles) | $0.50 |
| | Resend Pro | $20.00 |
| | Upstash Redis | $3.00 |
| | QStash Pro | $10.00 |
| **Domain** | .com domain | $1.00 |
| **Monitoring** | Sentry (free tier) | $0.00 |
| | Betterstack | $0.00 |
| **Total Monthly** | | **$149.01** |

**Annual recurring: ~$1,788.12**

### One-Time / Annual Costs

| Item | Cost | Frequency |
|------|------|-----------|
| Domain registration | $12.00 | Annual |
| SSL certificates | $0.00 | Auto |
| GitHub (Team) | $48.00 | Annual (optional) |
| Legal (ToS, Privacy Policy) | $500–2,000 | One-time |
| Logo / branding | $200–500 | One-time |
| **Total One-Time (Year 1)** | **$760–$2,560** | |
| **Total One-Time (Year 2+)** | **$60.00** | |

### Development Time Cost (Team)

| Task | Hours/Month | Team Size | Notes |
|------|-------------|-----------|-------|
| Backend development | 30–40 | 1 dev | API, queue, database |
| Frontend development | 20–30 | 1 dev | Dashboard, clip editor |
| DevOps / infrastructure | 10–15 | Shared | Monitoring, scaling |
| Bug fixes / maintenance | 10–15 | Shared | Ongoing |
| **Total** | **70–100 hrs/month** | **1–2 devs** | |

At $75/hour (blended contractor rate):

| Metric | Value |
|--------|-------|
| Monthly development cost | $5,250–$7,500 |
| Annual development cost | $63,000–$90,000 |

### Small Team TCO Summary

| Component | Year 1 | Year 2 | Year 3 |
|-----------|--------|--------|--------|
| Infrastructure + APIs | $1,788 | $1,788 | $1,788 |
| One-time costs | $760–$2,560 | $60 | $60 |
| Development time | $63,000–$90,000 | $63,000–$90,000 | $63,000–$90,000 |
| **Total TCO** | **$65,548–$94,348** | **$64,848–$91,848** | **$64,848–$91,848** |

**Cost per clip (3,000 clips/month): $1.82–$2.62**
**Cost per clip (6,000 clips/month): $0.91–$1.31**

---

## Build vs Buy Comparison

### Competitor Pricing (Opus Clip)

| Plan | Price | Clips/Month | Cost/Clip |
|------|-------|-------------|-----------|
| Starter | $19/month | 50 | $0.38 |
| Pro | $49/month | 150 | $0.33 |
| Business | $99/month | 500 | $0.20 |
| Enterprise | Custom | Unlimited | Contact sales |

### MiniOp vs Opus Clip Break-Even

| Clips/Month | MiniOp Infra Cost | Opus Clip Cost | MiniOp Wins? |
|-------------|-------------------|----------------|--------------|
| 50 | $1.15 | $19.00 | Yes (infra only) |
| 150 | $1.15 | $49.00 | Yes (infra only) |
| 500 | $1.15 | $99.00 | Yes (infra only) |
| 1,000 | $10.14 | $198.00+ | Yes (infra only) |
| 3,000 | $149.01 | $594.00+ | Yes (infra only) |

**Infrastructure alone, MiniOp is 10–60x cheaper than Opus Clip.**

But including development time:

| Scenario | MiniOp Year 1 TCO | Opus Clip Year 1 | Break-Even |
|----------|-------------------|-------------------|------------|
| Solo, 500 clips/mo | $10,014 | $1,188 | Never (Opus cheaper) |
| Team, 3,000 clips/mo | $65,128 | $7,128 | Never (Opus cheaper) |

### When MiniOp Makes Sense

The TCO math changes dramatically based on your situation:

**MiniOp is cheaper when:**
- You have existing development capacity (developers already on payroll)
- You need customization that Opus Clip doesn't offer
- You're building a product that embeds clip generation (B2B API)
- You process 10,000+ clips/month (scale advantages)
- You have compliance requirements (data sovereignty, on-prem)

**Opus Clip is cheaper when:**
- You need clips immediately with no development time
- Your team has no ML/backend expertise
- You process fewer than 500 clips/month
- You value support and reliability over customization

### SaaS Revenue Model

If you build MiniOp as a SaaS product:

| Metric | Conservative | Moderate | Aggressive |
|--------|-------------|----------|------------|
| Monthly subscribers | 50 | 200 | 1,000 |
| Price per subscriber | $15/month | $15/month | $15/month |
| Monthly revenue | $750 | $3,000 | $15,000 |
| Infrastructure cost | $149 | $300 | $800 |
| Gross margin | 85% | 90% | 95% |
| Development cost | $7,000/month | $7,000/month | $15,000/month |
| **Net monthly** | **-$6,364** | **-$4,300** | **+$14,200** |
| Break-even point | 467 subscribers | 467 subscribers | 1,000 subscribers |

---

## Hidden Costs

### Costs People Forget

| Hidden Cost | Estimate | Mitigation |
|-------------|----------|------------|
| GPU quota exhaustion | Colab throttling at peak | Kaggle backup, RunPod overflow |
| Storage growth | 90 GB/month at 3K clips | Lifecycle rules, 90-day retention |
| Bandwidth spikes | Viral content = sudden traffic | Cloudflare caching, rate limiting |
| Model updates | Re-download, re-test | Version pinning, staged rollouts |
| Support tickets | 2–5 hrs/month at scale | Documentation, FAQ, community |
| Security audits | $500–2,000/year | Automated scanning, pen testing |
| Legal compliance | $1,000–5,000/year | GDPR, DMCA handling |
| Backup and DR | $10–50/month | Supabase PITR, R2 versioning |

### Scaling Surprises

| Scale Point | What Breaks | Fix | Cost |
|-------------|-------------|-----|------|
| 1,000 clips/month | Colab session limits | Add RunPod persistent pod | +$53/month |
| 3,000 clips/month | Supabase connection limits | Connection pooling | +$0 (Supavisor) |
| 10,000 clips/month | Single RunPod worker | Multi-worker queue | +$50/month |
| 50,000 clips/month | Database performance | Read replicas | +$25/month |
| 100,000 clips/month | R2 egress patterns | CDN optimization | +$20/month |

---

## Three-Year Projection

### Solo Developer (500 clips/month steady)

| Year | Infrastructure | Development | Total |
|------|---------------|-------------|-------|
| 1 | $13.80 | $10,000–$17,500 | $10,014–$17,514 |
| 2 | $13.80 | $2,500–$5,000 | $2,514–$5,014 |
| 3 | $13.80 | $2,500–$5,000 | $2,514–$5,014 |
| **Total** | **$41.40** | **$15,000–$27,500** | **$15,041–$27,541** |

### Small Team (scaling from 3K to 10K clips/month)

| Year | Infrastructure | Development | Total |
|------|---------------|-------------|-------|
| 1 | $2,548 | $63,000–$90,000 | $65,548–$92,548 |
| 2 | $4,020 | $63,000–$90,000 | $67,020–$94,020 |
| 3 | $5,400 | $50,000–$75,000 | $55,400–$80,400 |
| **Total** | **$11,968** | **$176,000–$255,000** | **$187,968–$266,968** |

Year 3 development decreases as the product matures and maintenance replaces feature work.

---

## Recommendations

### For Side Projects
- **Start free.** Use Colab + Kaggle + Supabase free tier. Monthly cost: $1.15.
- **Don't over-engineer.** Skip the paid APIs until you have paying users.
- **Time-box development.** Set a 3-month MVP target to control opportunity cost.

### For Startups
- **Infrastructure is cheap; development is expensive.** Budget 90% for people, 10% for infra.
- **Start with the free tier stack and upgrade incrementally.** Don't pay for Supabase Pro until you hit connection limits.
- **Consider Opus Clip's API** if they offer one — building from scratch may not be worth it for standard use cases.

### For Enterprises
- **Self-host everything.** Data sovereignty and compliance justify the development cost.
- **Budget $100–200/month infrastructure** at 10K+ clips/month.
- **Hire dedicated ML engineers** rather than relying on Colab — production reliability matters.

The fundamental insight: MiniOp's infrastructure costs are negligible ($1–$114/month). The real cost is development time. Build MiniOp when you need customization, control, or scale that off-the-shelf tools can't provide.
