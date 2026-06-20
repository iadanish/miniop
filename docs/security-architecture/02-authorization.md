# Authorization and Role-Based Access Control (RBAC)

## Overview

MiniOp's authorization layer determines what authenticated users can do: which projects they can view, which videos they can edit, and which billing operations they can perform. The system uses a hybrid model combining PostgreSQL Row-Level Security (RLS) enforced at the database layer with application-level policy checks in the API middleware. This dual approach ensures that no query can bypass authorization even if application code has a bug.

---

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  API Route    │────▶│  App-Level       │────▶│  Supabase Client │
│  (Next.js)    │     │  Policy Check    │     │  (with JWT)      │
└──────────────┘     └──────────────────┘     └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌────────────────┐
                                               │  PostgreSQL     │
                                               │  RLS Policies   │
                                               │  (enforced)     │
                                               └────────────────┘
```

The application layer handles coarse-grained checks (is this user authenticated? do they have the right plan tier?) while RLS handles fine-grained row ownership (can this user see *this specific* project?). Even if a developer writes `supabase.from('projects').select('*')` without filtering, RLS automatically scopes the result to rows the JWT's `sub` claim owns or has been granted access to.

---

## Role Definitions

MiniOp defines four roles stored in the `user_roles` table:

```sql
-- supabase/migrations/002_roles.sql
CREATE TYPE app_role AS ENUM ('viewer', 'creator', 'team_admin', 'platform_admin');

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'viewer',
  granted_by UUID REFERENCES auth.users(id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);

CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
```

| Role | Permissions |
|---|---|
| `viewer` | View shared clips, read public projects |
| `creator` | Upload videos, create/edit own projects, manage own clips |
| `team_admin` | All creator permissions + manage team members, shared projects |
| `platform_admin` | Full access to all resources, billing overrides, user management |

### Extracting the Role into JWT

Supabase RLS policies run inside PostgreSQL and cannot make external calls. To make the role available in RLS policies, inject it into the JWT via a custom `access_token` hook:

```sql
-- supabase/migrations/003_jwt_hook.sql
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  claims JSONB;
  user_roles TEXT[];
BEGIN
  SELECT COALESCE(array_agg(role::TEXT), ARRAY['viewer'])
  INTO user_roles
  FROM public.user_roles
  WHERE user_id = (event->>'user_id')::UUID;

  claims := event->'claims';
  claims := jsonb_set(claims, '{user_roles}', to_jsonb(user_roles));

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;
```

Configure the hook in `supabase/config.toml`:

```toml
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token_hook"
```

The resulting JWT `app_metadata` now contains:

```json
{
  "user_roles": ["creator"]
}
```

---

## Row-Level Security (RLS) Policies

### Projects Table

```sql
-- supabase/migrations/004_rls_projects.sql
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Creators can view their own projects
CREATE POLICY "users_view_own_projects"
  ON projects FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

-- Creators can insert projects they own
CREATE POLICY "creators_insert_projects"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (
    owner_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
      AND role IN ('creator', 'team_admin', 'platform_admin')
    )
  );

-- Creators can update their own projects
CREATE POLICY "users_update_own_projects"
  ON projects FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- Creators can delete their own projects
CREATE POLICY "users_delete_own_projects"
  ON projects FOR DELETE
  TO authenticated
  USING (owner_id = auth.uid());

-- Team members can view shared projects
CREATE POLICY "team_members_view_shared_projects"
  ON projects FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT project_id FROM project_shares
      WHERE user_id = auth.uid()
    )
  );

-- Platform admins can access everything
CREATE POLICY "admins_full_access_projects"
  ON projects FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
      AND role = 'platform_admin'
    )
  );
```

### Videos Table

```sql
-- supabase/migrations/005_rls_videos.sql
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_view_own_videos"
  ON videos FOR SELECT
  TO authenticated
  USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
    )
    OR project_id IN (
      SELECT project_id FROM project_shares WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "creators_insert_videos"
  ON videos FOR INSERT
  TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
      AND role IN ('creator', 'team_admin', 'platform_admin')
    )
  );

CREATE POLICY "owners_update_own_videos"
  ON videos FOR UPDATE
  TO authenticated
  USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY "owners_delete_own_videos"
  ON videos FOR DELETE
  TO authenticated
  USING (
    project_id IN (
      SELECT id FROM projects WHERE owner_id = auth.uid()
    )
  );
```

### Shared Clips (Public Access)

```sql
-- supabase/migrations/006_rls_clips.sql
ALTER TABLE clips ENABLE ROW LEVEL SECURITY;

-- Anyone can view clips marked as public (for sharing)
CREATE POLICY "public_clips_viewable"
  ON clips FOR SELECT
  TO anon, authenticated
  USING (is_public = true);

-- Only owners can modify clips
CREATE POLICY "owners_manage_clips"
  ON clips FOR ALL
  TO authenticated
  USING (
    video_id IN (
      SELECT v.id FROM videos v
      JOIN projects p ON v.project_id = p.id
      WHERE p.owner_id = auth.uid()
    )
  );
```

---

## Application-Level Authorization

RLS handles database queries, but API routes need their own checks for non-database operations (file uploads, external API calls, billing).

### Permission Middleware

```typescript
// lib/authz/permissions.ts
import { SupabaseClient } from '@supabase/supabase-js'

type Permission =
  | 'project:create'
  | 'project:read'
  | 'project:update'
  | 'project:delete'
  | 'video:upload'
  | 'video:process'
  | 'team:manage'
  | 'billing:manage'
  | 'platform:admin'

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  viewer: ['project:read'],
  creator: [
    'project:create', 'project:read', 'project:update', 'project:delete',
    'video:upload', 'video:process',
  ],
  team_admin: [
    'project:create', 'project:read', 'project:update', 'project:delete',
    'video:upload', 'video:process', 'team:manage',
  ],
  platform_admin: [
    'project:create', 'project:read', 'project:update', 'project:delete',
    'video:upload', 'video:process', 'team:manage', 'billing:manage', 'platform:admin',
  ],
}

export async function getUserRoles(
  supabase: SupabaseClient,
  userId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)

  if (error) throw error
  return data.map(r => r.role)
}

export function hasPermission(roles: string[], permission: Permission): boolean {
  return roles.some(role =>
    ROLE_PERMISSIONS[role]?.includes(permission)
  )
}

export async function requirePermission(
  supabase: SupabaseClient,
  userId: string,
  permission: Permission
): Promise<void> {
  const roles = await getUserRoles(supabase, userId)
  if (!hasPermission(roles, permission)) {
    throw new AuthorizationError(
      `User ${userId} lacks permission: ${permission}`
    )
  }
}

export class AuthorizationError extends Error {
  status = 403
  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationError'
  }
}
```

### Usage in API Routes

```typescript
// app/api/projects/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { requirePermission, AuthorizationError } from '@/lib/authz/permissions'

export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await requirePermission(supabase, user.id, 'project:create')
  } catch (e) {
    if (e instanceof AuthorizationError) {
      return NextResponse.json({ error: e.message }, { status: 403 })
    }
    throw e
  }

  const body = await request.json()
  // RLS will also enforce owner_id = auth.uid() on insert
  const { data, error } = await supabase
    .from('projects')
    .insert({ ...body, owner_id: user.id })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json(data, { status: 201 })
}
```

### Resource-Level Authorization (Ownership Checks)

For operations on specific resources, verify ownership before modification:

```typescript
// lib/authz/ownership.ts
export async function assertProjectOwnership(
  supabase: SupabaseClient,
  userId: string,
  projectId: string
): Promise<void> {
  const { data, error } = await supabase
    .from('projects')
    .select('owner_id')
    .eq('id', projectId)
    .single()

  if (error || !data) {
    throw new AuthorizationError('Project not found')
  }

  if (data.owner_id !== userId) {
    // Check if user has shared access
    const { data: share } = await supabase
      .from('project_shares')
      .select('permission')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .single()

    if (!share) {
      throw new AuthorizationError('Not authorized to access this project')
    }
  }
}
```

---

## Free Tier vs. Scaled Production

### Free Tier

On the free tier, authorization is simple: every user is either a `viewer` or a `creator`. There are no teams, no shared projects, and no platform admin. RLS policies enforce `owner_id = auth.uid()` directly.

```sql
-- Simplified free-tier RLS (no team or admin checks)
CREATE POLICY "free_tier_select"
  ON projects FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY "free_tier_insert"
  ON projects FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid());
```

### Scaled Production

Production adds team collaboration, shared projects, and admin overrides. The full RLS policies shown above apply. Additional considerations:

**Policy performance**: RLS policies with subqueries (like checking `project_shares`) can be expensive at scale. Add covering indexes:

```sql
CREATE INDEX idx_project_shares_user_project
  ON project_shares(user_id, project_id);

CREATE INDEX idx_user_roles_user_role
  ON user_roles(user_id, role);
```

**Policy auditing**: Log all authorization decisions for compliance:

```sql
-- supabase/migrations/007_audit_log.sql
CREATE TABLE authorization_audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_audit_user ON authorization_audit_log(user_id, created_at);
```

**Centralized policy testing**: Write unit tests for every RLS policy:

```typescript
// tests/rls/projects.test.ts
import { createClient } from '@supabase/supabase-js'
import { describe, it, expect } from 'vitest'

describe('Projects RLS', () => {
  it('prevents users from viewing other users projects', async () => {
    const userASupabase = createClient(url, anonKey)
    // Sign in as user A
    await userASupabase.auth.signInWithPassword({ email: 'a@test.com', password: '...' })

    // Create a project as user A
    const { data: project } = await userASupabase
      .from('projects')
      .insert({ name: 'Private Project', owner_id: userA.id })
      .select()
      .single()

    // Sign in as user B
    const userBSupabase = createClient(url, anonKey)
    await userBSupabase.auth.signInWithPassword({ email: 'b@test.com', password: '...' })

    // User B should NOT see user A's project
    const { data: projects } = await userBSupabase
      .from('projects')
      .select('*')
      .eq('id', project.id)

    expect(projects).toHaveLength(0)
  })
})
```

---

## Summary

| Layer | Mechanism | Scope |
|---|---|---|
| Database (RLS) | PostgreSQL policies on every table | Row-level ownership, shared access, admin override |
| Application | Permission middleware in API routes | Coarse-grained role checks, non-DB operations |
| JWT Claims | `user_roles` array in token | Avoids DB lookup for role-based gating |

Both layers must agree. RLS is the safety net — if application code forgets a check, the database still enforces ownership. Application-level checks provide better error messages and prevent unnecessary database round-trips.

---

## Next Steps

- Review [01-authentication.md](./01-authentication.md) for how JWTs are issued and validated.
- Review [03-data-protection.md](./03-data-protection.md) for how authorized data is encrypted at rest and in transit.
