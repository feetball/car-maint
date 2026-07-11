import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StatusPill from './StatusPill.jsx';

describe('StatusPill', () => {
  const cases = [
    ['overdue', 'Overdue', 'status-pill--overdue'],
    ['due_soon', 'Due soon', 'status-pill--due-soon'],
    ['ok', 'OK', 'status-pill--ok'],
    ['no_history', 'No history', 'status-pill--no-history'],
  ];

  it.each(cases)('renders %s with the right label and class', (status, label, className) => {
    render(<StatusPill status={status} />);
    const pill = screen.getByText(label);
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('status-pill');
    expect(pill).toHaveClass(className);
  });

  it('falls back gracefully for unknown statuses', () => {
    render(<StatusPill status="mystery" />);
    const pill = screen.getByText('mystery');
    expect(pill).toHaveClass('status-pill--unknown');
  });
});
