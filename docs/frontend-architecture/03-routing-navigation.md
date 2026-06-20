# MiniOp Frontend Architecture: Routing and Navigation

## Overview

MiniOp uses the Next.js 14 App Router for all routing. This document defines every route in the application, the data each route loads, how navigation works between routes, how route protection is implemented, and how the routing strategy differs between the free-tier self-hosted deployment and the scaled production environment.

## Route Table

| Route | Type | Auth | Description |
|-------|------|------|-------------|
| `/` | Page | Public | Marketing landing page |
| `/login` | Page | Public | Email/password + OAuth login |
| `/signup` | Page | Public | Account registration |
| `/projects` | Page | Required | Project listing (dashboard home) |
| `/project/[id]` | Page | Required | Single project — video editor workspace |
| `/project/[id]/export` | Page | Required | Export configuration and download |
| `/settings` | Page | Required | User profile and preferences |
| `/settings/billing` | Page | Required | Subscription management (production only) |
| `/api/upload` | Route Handler | Required | Chunked video upload endpoint |
| `/api/clips` | Route Handler | Required | CRUD for clip metadata |
| `/api/clips/stream` | Route Handler | Required | SSE stream for processing status |
| `/api/webhooks/stripe` | Route Handler | Public (signed) | Stripe webhook receiver |
| `/api/auth/[...nextauth]` | Route Handler | Public | NextAuth.js authentication routes |

## Route Groups and Layouts

The app uses two route groups to separate authentication pages from the dashboard shell. Route groups don't affect the URL — they only control which layout wraps which pages.

```
app/
├── (auth)/                    # Wrapped by auth layout (centered card)
│   ├── layout.tsx
│   ├── login/page.tsx
│   └── signup/page.tsx
├── (dashboard)/               # Wrapped by dashboard layout (sidebar + top nav)
│   ├── layout.tsx
│   ├── projects/page.tsx
│   ├── project/
│   │   ├── [id]/page.tsx
│   │   └── [id]/export/page.tsx
│   ├── settings/page.tsx
│   └── settings/billing/page.tsx
├── layout.tsx                 # Root layout (html, body, fonts, providers)
└── page.tsx                   # Landing page (outside both groups)
```

### Root Layout

```tsx
// app/layout.tsx
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import '@/styles/globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: { default: 'MiniOp', template: '%s | MiniOp' },
  description: 'AI-powered video clipping for short-form content',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
```

### Auth Layout

```tsx
// app/(auth)/layout.tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">
        {children}
      </div>
    </div>
  );
}
```

### Dashboard Layout

The dashboard layout is the authenticated shell. It fetches the current user and renders the sidebar and top navigation around the page content.

```tsx
// app/(dashboard)/layout.tsx
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Sidebar } from '@/components/shared/Sidebar';
import { TopNav } from '@/components/shared/TopNav';
import { getProjects } from '@/lib/db/queries';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/login');

  const recentProjects = await getProjects(session.user.id, { limit: 5 });

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar recentProjects={recentProjects} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNav user={session.user} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
```

## Dynamic Routes

### Project Editor: `/project/[id]`

This is the core route of the application. The `[id]` segment identifies the project. The page is a Server Component that loads project data and passes it to the client-side `EditorWorkspace`.

```tsx
// app/(dashboard)/project/[id]/page.tsx
import { notFound } from 'next/navigation';
import { getProject, getClips } from '@/lib/db/queries';
import { requireAuth } from '@/lib/auth';
import { EditorWorkspace } from '@/components/editor/EditorWorkspace';
import type { Metadata } from 'next';

interface ProjectPageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const project = await getProject(params.id);
  return { title: project?.title ?? 'Project' };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const user = await requireAuth();
  const project = await getProject(params.id);

  if (!project || project.userId !== user.id) {
    notFound();
  }

  const clips = await getClips(params.id);

  return <EditorWorkspace project={project} clips={clips} />;
}
```

The `requireAuth()` helper wraps `getServerSession` and redirects to `/login` if the session is missing:

```tsx
// lib/auth.ts
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import { db } from './db/drizzle';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await db.query.users.findFirst({
          where: eq(users.email, credentials.email),
        });

        if (!user || !user.passwordHash) return null;

        const isValid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!isValid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.id as string;
      return session;
    },
  },
};

export async function requireAuth() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect('/login');
  return session.user;
}
```

## Navigation Components

### Sidebar

The sidebar is a client component that renders the main navigation and a list of recent projects. It collapses to icons on mobile.

```tsx
// components/shared/Sidebar.tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, FolderOpen, Settings, CreditCard, ChevronLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useLocalStorage } from '@/lib/hooks/useLocalStorage';
import type { Project } from '@/lib/types/project';

interface SidebarProps {
  recentProjects: Project[];
}

const navItems = [
  { href: '/projects', label: 'Projects', icon: LayoutDashboard },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/settings/billing', label: 'Billing', icon: CreditCard, productionOnly: true },
];

export function Sidebar({ recentProjects }: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useLocalStorage('miniop-sidebar-collapsed', false);

  const isProduction = process.env.NEXT_PUBLIC_ENABLE_BILLING === 'true';

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-muted/20 transition-all duration-200',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      <div className="flex h-14 items-center justify-between border-b px-4">
        {!collapsed && (
          <Link href="/projects" className="text-lg font-bold tracking-tight">
            MiniOp
          </Link>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeft className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />
        </Button>
      </div>

      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-1 px-2">
          {navItems
            .filter((item) => !item.productionOnly || isProduction)
            .map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  pathname === item.href
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            ))}
        </nav>

        {!collapsed && recentProjects.length > 0 && (
          <>
            <Separator className="my-4" />
            <div className="px-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Recent
              </h4>
              <div className="space-y-1">
                {recentProjects.map((project) => (
                  <Link
                    key={project.id}
                    href={`/project/${project.id}`}
                    className={cn(
                      'block truncate rounded-md px-2 py-1.5 text-sm transition-colors',
                      pathname === `/project/${project.id}`
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    {project.title}
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}
      </ScrollArea>
    </aside>
  );
}
```

### TopNav

```tsx
// components/shared/TopNav.tsx
'use client';

import { signOut } from 'next-auth/react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from './ThemeToggle';

interface TopNavProps {
  user: { name?: string | null; email?: string | null; image?: string | null };
}

export function TopNav({ user }: TopNavProps) {
  const initials = user.name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() ?? '?';

  return (
    <header className="flex h-14 items-center justify-between border-b px-6">
      <div />
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 rounded-full">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user.image ?? undefined} alt={user.name ?? ''} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="px-2 py-1.5">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href="/settings">Settings</a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href="/settings/billing">Billing</a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut({ callbackUrl: '/login' })}>
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
```

## Middleware: Route Protection

Next.js middleware runs on every request before the page renders. It handles authentication redirects and feature gating at the edge.

```tsx
// middleware.ts
import { withAuth } from 'next-auth/middleware';
import { NextResponse } from 'next/server';

export default withAuth(
  function middleware(req) {
    const { pathname } = req.nextUrl;
    const token = req.nextauth.token;

    // Billing page is production-only
    if (pathname.startsWith('/settings/billing') && process.env.NEXT_PUBLIC_ENABLE_BILLING !== 'true') {
      return NextResponse.redirect(new URL('/settings', req.url));
    }

    // Redirect authenticated users away from auth pages
    if (token && (pathname === '/login' || pathname === '/signup')) {
      return NextResponse.redirect(new URL('/projects', req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      authorized: ({ token, req }) => {
        const { pathname } = req.nextUrl;

        // Public routes
        if (pathname === '/' || pathname === '/login' || pathname === '/signup') return true;
        if (pathname.startsWith('/api/webhooks')) return true;

        // Everything else requires auth
        return !!token;
      },
    },
  }
);

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public/).*)'],
};
```

## Programmatic Navigation

Use Next.js `useRouter` for client-side navigation. Common patterns in MiniOp:

```tsx
// After creating a project
router.push(`/project/${project.id}`);

// After deleting a project, go back to list
router.push('/projects');

// Replace current URL (no history entry) — used for tab switches
router.replace(`/project/${id}?tab=subtitles`, { scroll: false });

// Refresh server data without full page reload
router.refresh();
```

## Loading and Error States

Each route group defines a `loading.tsx` and `error.tsx` for instant feedback:

```tsx
// app/(dashboard)/loading.tsx
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
```

```tsx
// app/(dashboard)/error.tsx
'use client';

import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={reset} className="mt-4">
        Try again
      </Button>
    </div>
  );
}
```

## Free Tier vs. Production Routing

### Free Tier

- **No `/settings/billing` route** — middleware redirects to `/settings`.
- **No `/api/webhooks/stripe`** — the route handler file can exist but returns 404 if Stripe keys are not configured.
- **No Google OAuth** — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are omitted from `.env`, so the provider is conditionally included:

```tsx
// lib/auth.ts (provider array)
providers: [
  CredentialsProvider({ /* ... */ }),
  ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? [GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      })]
    : []),
],
```

### Production

- **Middleware adds rate limiting** via Upstash Redis — each authenticated request increments a counter keyed by user ID. Exceeding the limit returns 429.
- **`/settings/billing`** renders a Stripe Customer Portal link generated server-side.
- **`/api/webhooks/stripe`** handles `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted` events to sync subscription status.
- **Subdomain routing** (optional): white-label deployments can use `middleware.ts` to rewrite `tenant.miniop.app` to `/tenant/[tenantId]/projects`.

## Navigation Performance

### Prefetching

Next.js automatically prefetches routes rendered with `<Link>`. The sidebar links are prefetched on hover, making navigation near-instant. Disable prefetching for heavy routes if needed:

```tsx
<Link href="/project/heavy-project" prefetch={false}>
  Heavy Project
</Link>
```

### Parallel Routes (Future)

For the editor, parallel routes can load the transcript panel and the video player independently:

```
app/
└── project/
    └── [id]/
        ├── layout.tsx
        ├── page.tsx           # Video player
        └── @transcript/
            └── page.tsx       # Transcript panel (parallel)
```

```tsx
// app/project/[id]/layout.tsx
export default function EditorLayout({
  children,
  transcript,
}: {
  children: React.ReactNode;
  transcript: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_350px]">
      {children}
      {transcript}
    </div>
  );
}
```

This allows the video player and transcript to stream independently — if the transcript query is slow, the video player still renders immediately.

## Commands Reference

```bash
# Development
npm run dev                    # Start Next.js dev server on :3000

# Build and production
npm run build                  # Production build
npm run start                  # Start production server

# Lint and type check
npm run lint                   # ESLint
npx tsc --noEmit               # TypeScript type checking

# Database migrations (Drizzle)
npx drizzle-kit generate       # Generate migration files
npx drizzle-kit migrate        # Run migrations
npx drizzle-kit studio         # Open Drizzle Studio (local DB inspector)
```

## Next Steps

- See [01-component-structure.md](./01-component-structure.md) for the component tree that these routes render.
- See [02-state-management.md](./02-state-management.md) for how data flows through routes and layouts.
