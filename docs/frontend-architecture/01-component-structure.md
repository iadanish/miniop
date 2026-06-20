# MiniOp Frontend Architecture: Component Structure

## Overview

MiniOp is an AI-powered video clipping platform that automatically generates short-form clips from long-form video content. This document defines the component architecture for both the free-tier single-user deployment and the scaled production environment serving thousands of concurrent users. The stack is Next.js 14 (App Router), React 18, TypeScript 5.x, Tailwind CSS 3.4, and Shadcn/ui as the component library foundation.

## Directory Layout

```
src/
├── app/                          # Next.js 14 App Router
│   ├── (auth)/                   # Route group: authentication
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   ├── (dashboard)/              # Route group: authenticated app
│   │   ├── layout.tsx            # Sidebar + top nav shell
│   │   ├── projects/page.tsx     # Project listing
│   │   ├── project/[id]/page.tsx # Single project workspace
│   │   ├── settings/page.tsx
│   │   └── billing/page.tsx      # Production only
│   ├── api/                      # Route handlers
│   │   ├── upload/route.ts
│   │   ├── clips/route.ts
│   │   └── webhooks/stripe/route.ts
│   ├── layout.tsx                # Root layout (providers, fonts)
│   └── page.tsx                  # Landing / marketing page
├── components/
│   ├── ui/                       # Shadcn/ui primitives (Button, Dialog, etc.)
│   ├── shared/                   # Cross-feature shared components
│   │   ├── AppShell.tsx
│   │   ├── Sidebar.tsx
│   │   ├── TopNav.tsx
│   │   ├── EmptyState.tsx
│   │   └── FileDropZone.tsx
│   ├── editor/                   # Video editor domain components
│   │   ├── Timeline.tsx
│   │   ├── ClipCard.tsx
│   │   ├── TranscriptPanel.tsx
│   │   ├── WaveformDisplay.tsx
│   │   ├── SubtitleOverlay.tsx
│   │   └── ExportDialog.tsx
│   ├── upload/                   # Upload flow components
│   │   ├── UploadProgress.tsx
│   │   ├── UrlInput.tsx
│   │   └── ProcessingStatus.tsx
│   └── project/                  # Project management components
│       ├── ProjectGrid.tsx
│       ├── ProjectCard.tsx
│       └── CreateProjectDialog.tsx
├── lib/
│   ├── utils.ts                  # cn() helper, formatters
│   ├── hooks/                    # Custom React hooks
│   │   ├── useTimeline.ts
│   │   ├── useClipSelection.ts
│   │   ├── useVideoPlayer.ts
│   │   ├── useKeyboardShortcuts.ts
│   │   └── useUpload.ts
│   ├── types/                    # TypeScript type definitions
│   │   ├── project.ts
│   │   ├── clip.ts
│   │   └── timeline.ts
│   └── constants/
│       ├── keyboard.ts
│       └── limits.ts             # Free tier vs production limits
```

## Component Design Principles

### 1. Server Components by Default

Every component in the `app/` directory is a React Server Component (RSC) unless it explicitly requires client interactivity. This reduces the JavaScript bundle sent to the browser.

```tsx
// app/(dashboard)/projects/page.tsx — Server Component
import { getProjects } from '@/lib/db/queries';
import { ProjectGrid } from '@/components/project/ProjectGrid';

export default async function ProjectsPage() {
  const projects = await getProjects(); // Direct DB access, no API layer
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      <ProjectGrid projects={projects} />
    </div>
  );
}
```

### 2. Client Components for Interactivity

Components that handle user input, browser APIs, or React state use the `'use client'` directive. The boundary is pushed as deep as possible.

```tsx
// components/editor/Timeline.tsx
'use client';

import { useRef, useCallback } from 'react';
import { useTimeline } from '@/lib/hooks/useTimeline';
import { useClipSelection } from '@/lib/hooks/useClipSelection';
import { cn } from '@/lib/utils';
import type { Clip, TimelineRegion } from '@/lib/types/timeline';

interface TimelineProps {
  clips: Clip[];
  duration: number;
  onClipSelect: (clipId: string) => void;
  onRegionChange: (region: TimelineRegion) => void;
}

export function Timeline({ clips, duration, onClipSelect, onRegionChange }: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollLeft, pixelsPerSecond, zoom } = useTimeline(containerRef, duration);
  const { selectedClipId, handleSelect } = useClipSelection(clips, onClipSelect);

  const handleDragEnd = useCallback(
    (clipId: string, newStart: number, newEnd: number) => {
      onRegionChange({ clipId, start: newStart, end: newEnd });
    },
    [onRegionChange]
  );

  return (
    <div
      ref={containerRef}
      className="relative h-32 w-full overflow-x-auto rounded-lg border bg-muted/30"
    >
      <div
        className="relative h-full"
        style={{ width: `${duration * pixelsPerSecond}px` }}
      >
        {clips.map((clip) => (
          <ClipTrack
            key={clip.id}
            clip={clip}
            pixelsPerSecond={pixelsPerSecond}
            isSelected={clip.id === selectedClipId}
            onSelect={() => handleSelect(clip.id)}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>
    </div>
  );
}
```

### 3. Composition Over Configuration

Components accept children and render props instead of boolean flags. This keeps the API surface small and the rendering flexible.

```tsx
// components/shared/EmptyState.tsx
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 text-center', className)}>
      <div className="mb-4 text-muted-foreground">{icon}</div>
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground max-w-sm">{description}</p>
      {action && (
        <Button onClick={action.onClick} className="mt-4">
          {action.label}
        </Button>
      )}
    </div>
  );
}
```

## Free Tier vs. Scaled Production

### Free Tier (Self-Hosted, Single User)

The free tier has no billing, no multi-tenancy, and no queue system. Components simplify accordingly:

- **No `<BillingBanner />`** — billing page and upgrade prompts are removed via feature flags.
- **No rate-limit UI** — the upload component doesn't display remaining credits.
- **Simplified project list** — no pagination, no search (all projects fit in memory).
- **Local file storage** — the upload component reads from the filesystem, not S3.

Feature gating uses a simple environment-driven config:

```tsx
// lib/constants/limits.ts
export const PLAN_LIMITS = {
  free: {
    maxClipsPerProject: 10,
    maxVideoDurationMinutes: 60,
    maxUploadsPerDay: 5,
    exportResolutions: ['720p', '1080p'] as const,
    enableSubtitles: true,
    enableBgm: false,
  },
  pro: {
    maxClipsPerProject: 100,
    maxVideoDurationMinutes: 240,
    maxUploadsPerDay: 50,
    exportResolutions: ['720p', '1080p', '4K'] as const,
    enableSubtitles: true,
    enableBgm: true,
  },
} as const;

export type PlanTier = keyof typeof PLAN_LIMITS;
```

### Scaled Production

Production adds:

- **`<CreditBadge />`** in TopNav showing remaining processing minutes.
- **`<UpgradePrompt />`** wrapper that gates premium features behind a Shadcn Dialog.
- **Virtualized project list** using `@tanstack/react-virtual` for accounts with 100+ projects.
- **Real-time processing status** via Server-Sent Events — `<ProcessingStatus />` subscribes to clip generation progress.

```tsx
// components/upload/ProcessingStatus.tsx
'use client';

import { useEffect, useState } from 'react';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import type { ProcessingEvent } from '@/lib/types/clip';

interface ProcessingStatusProps {
  projectId: string;
  onComplete: (clipIds: string[]) => void;
}

export function ProcessingStatus({ projectId, onComplete }: ProcessingStatusProps) {
  const [events, setEvents] = useState<ProcessingEvent[]>([]);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const source = new EventSource(`/api/clips/stream?projectId=${projectId}`);

    source.onmessage = (event) => {
      const data: ProcessingEvent = JSON.parse(event.data);
      setEvents((prev) => [...prev, data]);

      if (data.type === 'progress') {
        setProgress(data.percent);
      } else if (data.type === 'complete') {
        onComplete(data.clipIds);
        source.close();
      } else if (data.type === 'error') {
        source.close();
      }
    };

    return () => source.close();
  }, [projectId, onComplete]);

  const currentStage = events[events.length - 1];

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Processing Video</h3>
        <Badge variant={currentStage?.type === 'error' ? 'destructive' : 'secondary'}>
          {currentStage?.stage ?? 'Queued'}
        </Badge>
      </div>
      <Progress value={progress} className="h-2" />
      <p className="text-sm text-muted-foreground">
        {currentStage?.message ?? 'Waiting for processing to begin...'}
      </p>
    </div>
  );
}
```

## Shadcn/ui Integration

Install components as needed — they live in `src/components/ui/` and are fully owned by the codebase:

```bash
npx shadcn@latest add button dialog dropdown-menu progress badge
npx shadcn@latest add sheet separator avatar scroll-area
```

Shadcn components are customized via `tailwind.config.ts` design tokens:

```ts
// tailwind.config.ts (excerpt)
import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
```

## Accessibility

Every interactive component must:

1. Use semantic HTML (`<button>`, not `<div onClick>`).
2. Support keyboard navigation — the `Timeline` component binds `ArrowLeft`/`ArrowRight` for clip navigation, `Space` for play/pause.
3. Include `aria-label` on icon-only buttons.
4. Maintain a minimum 4.5:1 contrast ratio for text (enforced by Tailwind's `text-foreground` token on `background`).

The `useKeyboardShortcuts` hook centralizes all editor shortcuts:

```tsx
// lib/hooks/useKeyboardShortcuts.ts
'use client';

import { useEffect } from 'react';

type ShortcutMap = Record<string, () => void>;

export function useKeyboardShortcuts(shortcuts: ShortcutMap) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = [
        e.metaKey || e.ctrlKey ? 'mod' : '',
        e.shiftKey ? 'shift' : '',
        e.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');

      if (shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcuts]);
}
```

## Testing Components

Components are tested with Vitest + React Testing Library. Server components are tested by mocking the data layer:

```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

```tsx
// components/project/__tests__/ProjectCard.test.tsx
import { render, screen } from '@testing-library/react';
import { ProjectCard } from '../ProjectCard';

const mockProject = {
  id: 'proj_123',
  title: 'My Podcast Episode',
  thumbnailUrl: '/thumbnails/proj_123.jpg',
  clipCount: 5,
  createdAt: new Date('2024-01-15'),
  status: 'completed' as const,
};

describe('ProjectCard', () => {
  it('renders project title and clip count', () => {
    render(<ProjectCard project={mockProject} />);
    expect(screen.getByText('My Podcast Episode')).toBeInTheDocument();
    expect(screen.getByText('5 clips')).toBeInTheDocument();
  });

  it('shows processing badge when status is processing', () => {
    render(<ProjectCard project={{ ...mockProject, status: 'processing' }} />);
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });
});
```

## Next Steps

- See [02-state-management.md](./02-state-management.md) for how application state flows through these components.
- See [03-routing-navigation.md](./03-routing-navigation.md) for route definitions and navigation patterns.
