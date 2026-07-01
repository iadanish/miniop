import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
  }),
}));

import LoginPage from '../src/app/(auth)/login/page';

describe('Login', () => {
  it('renders sign in heading', () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeDefined();
  });

  it('renders email and password inputs', () => {
    render(<LoginPage />);
    expect(screen.getByLabelText(/email/i)).toBeDefined();
    expect(screen.getByLabelText(/password/i)).toBeDefined();
  });

  it('renders sign in button', () => {
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDefined();
  });

  it('renders link to signup', () => {
    render(<LoginPage />);
    expect(screen.getByRole('link', { name: /sign up/i })).toBeDefined();
  });
});
