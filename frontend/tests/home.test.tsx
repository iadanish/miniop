import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import Home from '../src/app/page';

describe('Home', () => {
  it('renders heading', () => {
    render(<Home />);
    expect(screen.getByRole('heading', { name: /miniop/i })).toBeDefined();
  });

  it('renders description', () => {
    render(<Home />);
    expect(screen.getByText(/open-source/i)).toBeDefined();
  });
});
