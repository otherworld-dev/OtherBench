import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '@grunt/core/types/thread.js';
import { TodoChecklist } from './TodoChecklist.js';

const item = (content: string, status: TodoItem['status']): TodoItem => ({ content, status, activeForm: `${content}-ing` });

describe('TodoChecklist', () => {
  afterEach(cleanup);
  it('counts what is done, names each status in words, and shows the running step as it runs', () => {
    render(<TodoChecklist todos={[item('Read', 'completed'), item('Write', 'in_progress'), item('Test', 'pending')]} streaming />);
    expect(screen.getByText('Progress · 1 of 3 done')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Done: Read' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'In progress: Write' })).toHaveTextContent('Write-ing');
    expect(screen.getByRole('listitem', { name: 'To do: Test' })).toBeInTheDocument();
  });
  it('is open while the reply streams and folded once it ends', () => {
    const { rerender } = render(<TodoChecklist todos={[item('Read', 'completed')]} streaming />);
    expect(screen.getByTestId('todo-checklist')).toHaveAttribute('open');
    rerender(<TodoChecklist todos={[item('Read', 'completed')]} streaming={false} />);
    expect(screen.getByTestId('todo-checklist')).not.toHaveAttribute('open');
  });
  it('shows the first 50 steps and sums up the rest', () => {
    render(<TodoChecklist todos={Array.from({ length: 53 }, (_, i) => item(`Step ${i}`, 'pending'))} streaming />);
    expect(screen.getAllByRole('listitem', { name: /^To do: Step/ })).toHaveLength(50);
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
  });
});
