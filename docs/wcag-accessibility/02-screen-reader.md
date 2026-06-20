# Screen Reader Support for MiniOp

## Overview

MiniOp is tested against **NVDA** (Windows), **VoiceOver** (macOS/iOS), and **TalkBack** (Android). This document covers ARIA implementation patterns, live region management, custom widget accessibility, and tier-specific deployment considerations. The goal: a screen reader user can create a project, upload video, select highlights, edit clips, and export — independently.

---

## ARIA Landmark Structure

MiniOp's application shell uses landmark roles so screen reader users can navigate by region:

```html
<!-- Rendered shell structure -->
<a href="#main-content" class="skip-link">Skip to main content</a>

<header role="banner">
  <nav aria-label="Primary">
    <ul role="menubar">
      <li role="none"><a role="menuitem" href="/dashboard">Dashboard</a></li>
      <li role="none"><a role="menuitem" href="/projects">Projects</a></li>
      <li role="none"><a role="menuitem" href="/export">Export</a></li>
    </ul>
  </nav>
</header>

<main id="main-content" role="main" aria-label="Clip editor">
  <!-- Dynamic content injected here -->
</main>

<aside role="complementary" aria-label="Clip properties">
  <!-- Right sidebar: metadata, captions, export settings -->
</aside>

<div role="region" aria-label="Notifications" aria-live="polite" id="toast-region">
  <!-- Toast messages rendered here -->
</div>
```

Screen reader users can jump between landmarks using their screen reader's landmark navigation shortcut (NVDA: `D`, VoiceOver: `VO+U` then arrows).

---

## Live Regions for Processing Status

Video processing is asynchronous. MiniOp uses ARIA live regions to announce status changes without requiring the user to poll:

```tsx
// src/components/ProcessingStatus.tsx
import { useEffect, useState } from 'react';

export function ProcessingStatus({ clipId }: { clipId: string }) {
  const [status, setStatus] = useState<'uploading' | 'processing' | 'ready' | 'failed'>('uploading');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const eventSource = new EventSource(`/api/v1/clips/${clipId}/status`);
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setStatus(data.status);
      setProgress(data.progress);
    };
    return () => eventSource.close();
  }, [clipId]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="processing-banner"
    >
      {status === 'uploading' && <p>Uploading video... {progress}%</p>}
      {status === 'processing' && <p>Analyzing video for highlights... {progress}% complete</p>}
      {status === 'ready' && <p>Processing complete. 5 highlights found.</p>}
      {status === 'failed' && <p role="alert">Processing failed. Please retry.</p>}
    </div>
  );
}
```

Key rules:
- `role="status"` with `aria-live="polite"` for non-urgent updates (progress percentages)
- `role="alert"` with implicit `aria-live="assertive"` for errors only
- `aria-atomic="true"` so the screen reader re-reads the entire region, not just the changed text

---

## Custom Timeline Widget

The timeline is MiniOp's most complex custom widget. It uses a composite ARIA pattern combining a slider and a listbox:

```tsx
// src/components/Timeline.tsx
export function Timeline({ clips, currentTime, onSelect, onSeek }) {
  return (
    <div
      role="group"
      aria-label="Video timeline"
      aria-roledescription="timeline"
    >
      {/* Seek bar */}
      <div
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={currentTime}
        aria-valuetext={`${Math.floor(currentTime / 60)} minutes ${currentTime % 60} seconds`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onSeek(currentTime + 5);
          if (e.key === 'ArrowLeft') onSeek(currentTime - 5);
          if (e.key === 'Home') onSeek(0);
          if (e.key === 'End') onSeek(100);
        }}
      />

      {/* Clip list */}
      <ul role="listbox" aria-label="Detected highlights" aria-multiselectable="true">
        {clips.map((clip, i) => (
          <li
            key={clip.id}
            role="option"
            aria-selected={clip.selected}
            aria-label={`${clip.label}, ${clip.startTime} to ${clip.endTime}, duration ${clip.duration} seconds`}
            tabIndex={i === 0 ? 0 : -1}
            onKeyDown={(e) => handleListboxNav(e, i)}
          >
            <ClipCard clip={clip} />
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### `aria-valuetext` Rationale

A raw `aria-valuenow` of `42.5` on the seek slider is meaningless to screen reader users. `aria-valuetext` provides a human-readable timestamp: `"0 minutes 42 seconds"`.

### Listbox Keyboard Pattern

The clip list follows the [WAI-ARIA Listbox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/):

| Key | Action |
|-----|--------|
| `ArrowDown` | Move to next clip |
| `ArrowUp` | Move to previous clip |
| `Space` | Toggle selection |
| `Home` | Jump to first clip |
| `End` | Jump to last clip |
| `Shift+ArrowDown` | Extend selection down |
| `Shift+ArrowUp` | Extend selection up |

---

## Modal Dialog Accessibility

Export settings, project creation, and confirmation dialogs use a fully accessible modal pattern:

```tsx
// src/components/ui/Modal.tsx
import { useEffect, useRef } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement;
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
      previousFocus.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };

    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="modal-title"
      aria-modal="true"
    >
      <h2 id="modal-title">{title}</h2>
      {children}
      <button onClick={onClose}>Close</button>
    </dialog>
  );
}
```

The native `<dialog>` element with `showModal()` provides:
- Focus trapping (Tab cycles within the dialog)
- Escape key dismissal via the `cancel` event
- Backdrop overlay
- Inert background (other content is not interactive)

---

## Announcing Dynamic Content Changes

When the user selects a clip in the timeline, the properties panel updates. Announce the change:

```tsx
// src/components/ClipProperties.tsx
export function ClipProperties({ clip }: { clip: Clip | null }) {
  const announcer = useAnnouncer();

  useEffect(() => {
    if (clip) {
      announcer.announce(
        `Selected: ${clip.label}. Duration: ${clip.duration} seconds. ` +
        `${clip.hasCaptions ? 'Captions available.' : 'No captions.'}`
      );
    }
  }, [clip]);

  if (!clip) return <p>No clip selected</p>;

  return (
    <section aria-label="Clip properties">
      <dl>
        <dt>Label</dt><dd>{clip.label}</dd>
        <dt>Start</dt><dd>{formatTime(clip.startTime)}</dd>
        <dt>End</dt><dd>{formatTime(clip.endTime)}</dd>
        <dt>Captions</dt><dd>{clip.hasCaptions ? 'Yes' : 'No'}</dd>
      </dl>
    </section>
  );
}
```

The `useAnnouncer` hook manages a visually-hidden live region:

```typescript
// src/hooks/useAnnouncer.ts
export function useAnnouncer() {
  const regionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.className = 'sr-only'; // visually hidden
    document.body.appendChild(el);
    regionRef.current = el;
    return () => el.remove();
  }, []);

  return {
    announce(message: string) {
      if (regionRef.current) {
        regionRef.current.textContent = '';
        requestAnimationFrame(() => {
          if (regionRef.current) regionRef.current.textContent = message;
        });
      }
    },
  };
}
```

The `requestAnimationFrame` trick forces the screen reader to detect a text change (clearing then setting in the same frame would be ignored).

---

## Video Player Accessibility

The embedded video player must be operable without a mouse:

```tsx
// src/components/VideoPlayer.tsx
export function VideoPlayer({ src, captionsUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <div className="player-container" role="region" aria-label="Video player">
      <video
        ref={videoRef}
        src={src}
        aria-label="Project video"
        controls
      >
        <track kind="captions" src={captionsUrl} label="English" srclang="en" default />
        Your browser does not support the video element.
      </video>

      <div className="player-controls" role="toolbar" aria-label="Playback controls">
        <button aria-label="Play" onClick={() => videoRef.current?.play()}>▶</button>
        <button aria-label="Pause" onClick={() => videoRef.current?.pause()}>⏸</button>
        <button aria-label="Rewind 10 seconds" onClick={() => { if (videoRef.current) videoRef.current.currentTime -= 10; }}>⏪</button>
        <button aria-label="Forward 10 seconds" onClick={() => { if (videoRef.current) videoRef.current.currentTime += 10; }}>⏩</button>
        <button aria-label="Toggle captions" onClick={toggleCaptions}>CC</button>
      </div>
    </div>
  );
}
```

---

## Tier-Specific Configuration

### Free Tier

For self-hosted deployments, enable the built-in screen reader testing suite:

```bash
npm run test:a11y:screen-reader
```

This runs Playwright tests that assert ARIA attributes, live region behavior, and landmark structure. Results are written to `test-results/a11y-report.json`.

### Scaled Production

In production, add screen reader compatibility headers for assistive technology detection (used for analytics, not blocking):

```nginx
# nginx.conf
server {
    location / {
        proxy_set_header X-AT-Detected $http_user_agent;

        # Cache accessibility-enhanced responses separately
        # when assistive technology is detected
        set $a11y_suffix "";
        if ($http_user_agent ~* "(NVDA|JAWS|VoiceOver|TalkBack)") {
            set $a11y_suffix "-sr";
        }
        proxy_cache_key "$uri$a11y_suffix";
    }
}
```

Serve enhanced markup (longer `aria-label`, additional `aria-describedby` text) to screen reader sessions without penalizing performance for other users.

---

## Testing Matrix

| Screen Reader | Browser | Platform | Status |
|--------------|---------|----------|--------|
| NVDA 2024.1 | Chrome 125+ | Windows 11 | Primary target |
| NVDA 2024.1 | Firefox 126+ | Windows 11 | Secondary |
| VoiceOver | Safari 17+ | macOS 14 | Primary target |
| VoiceOver | Safari | iOS 17 | Mobile primary |
| TalkBack | Chrome | Android 14 | Mobile secondary |

Run the automated suite against each combination in CI:

```yaml
# .github/workflows/sr-tests.yml
- name: Run screen reader tests
  run: npx playwright test --project=nvda-chrome --project=vo-safari
```

---

## References

- [WAI-ARIA Authoring Practices - Patterns](https://www.w3.org/WAI/ARIA/apg/patterns/)
- [MDN: ARIA Live Regions](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/ARIA_Live_Regions)
- [NVDA User Guide](https://www.nvaccess.org/files/nvda/documentation/userGuide.html)
- [VoiceOver macOS Commands](https://support.apple.com/guide/voiceover/keyboard-commands-vo4be2c80f7/mac)
