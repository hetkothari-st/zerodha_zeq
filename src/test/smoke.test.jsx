import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

test('harness renders React with jest-dom matchers', () => {
    render(<h1>hello</h1>);
    expect(screen.getByRole('heading', { name: 'hello' })).toBeInTheDocument();
});
