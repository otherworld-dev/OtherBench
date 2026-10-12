import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { OfficePreview, PresentationPreview } from './OfficePreview.js';

afterEach(cleanup);

const BUDGET = JSON.stringify({
  sheets: [
    { name: 'Budget', columns: [{ width: 20 }, { width: 12 }], freeze: { rows: 1 }, rows: [[{ value: 'Items', bold: true }, { value: 'Cost', bold: true }], ['Widgets', 12], ['Gadgets', 30.5], ['Total', '=SUM(B2:B3)']] },
    { name: 'Notes', rows: [['Second sheet text', { date: '2026-10-12T09:30' }, true]] },
  ],
});

describe('OfficePreview', () => {
  it('draws a document as formatted Markdown on a page', () => {
    render(<OfficePreview kind="document" content={'# Quarterly memo\n\nSales are **up**.'} />);
    expect(screen.getByRole('heading', { name: 'Quarterly memo' })).toBeInTheDocument();
    expect(screen.getByTestId('office-page')).toBeInTheDocument();
  });

  it('draws a spreadsheet with column letters, row numbers, its cells and its formulas as formulas', () => {
    render(<OfficePreview kind="spreadsheet" content={BUDGET} />);
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '4' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Total' })).toBeInTheDocument();
    expect(screen.getByText('=SUM(B2:B3)')).toBeInTheDocument();
    expect(screen.getByTitle('=SUM(B2:B3)')).toBeInTheDocument();
    expect(screen.getByText(/Formulas are worked out when the file is opened in Excel, LibreOffice or Google Sheets/)).toBeInTheDocument();
    // Bold from the source.
    expect(screen.getByRole('cell', { name: 'Items' })).toHaveStyle({ fontWeight: '700' });
  });

  it('has a tab per sheet', async () => {
    render(<OfficePreview kind="spreadsheet" content={BUDGET} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Budget', 'Notes']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.setup().click(tabs[1]!);
    expect(screen.getByRole('cell', { name: 'Second sheet text' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2026-10-12 09:30' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'TRUE' })).toBeInTheDocument();
  });

  it('says when it shows only the first 1,000 rows', () => {
    const rows = Array.from({ length: 1001 }, (_, i) => [i]);
    render(<OfficePreview kind="spreadsheet" content={JSON.stringify({ sheets: [{ name: 'Big', rows }] })} />);
    expect(screen.getByText('Showing the first 1,000 rows.')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).queryByRole('rowheader', { name: '1001' })).toBeNull();
  });

  it("shows the parse error for a source it can't read, and points at Source", () => {
    render(<OfficePreview kind="spreadsheet" content={'{"sheets":'} />);
    expect(screen.getByRole('alert')).toHaveTextContent("The content isn't valid JSON");
    expect(screen.getByRole('alert')).toHaveTextContent('Use Source to see it.');
  });
});

describe('PresentationPreview', () => {
  const DECK = JSON.stringify({
    theme: { accent: '#AA3300' },
    slides: [
      { layout: 'title', title: 'Mock review', subtitle: 'From the mock model' },
      { layout: 'bullets', title: 'Highlights', bullets: ['Revenue up', { text: 'Two new clients', level: 1 }], notes: 'Mention churn.' },
      { layout: 'section', title: 'Results' },
      { layout: 'table', title: 'Costs', table: { header: ['Item', 'Cost'], rows: [['Widgets', 12]] } },
      { layout: 'two-column', title: 'Then and now', left: { heading: 'Then', bullets: ['Manual'] }, right: { bullets: ['Automatic'] } },
    ],
  });

  it('draws each slide as a numbered card with its titles, bullets, table and notes', () => {
    render(<PresentationPreview content={DECK} />);
    const slides = screen.getAllByRole('figure');
    expect(slides).toHaveLength(5);
    expect(within(slides[0]!).getByText('Mock review')).toBeInTheDocument();
    expect(within(slides[0]!).getByText('From the mock model')).toBeInTheDocument();
    expect(within(slides[1]!).getByText('Highlights')).toBeInTheDocument();
    expect(within(slides[1]!).getByText('Two new clients')).toBeInTheDocument();
    expect(within(slides[1]!).getByText('Notes: Mention churn.')).toBeInTheDocument();
    expect(within(slides[3]!).getByRole('cell', { name: 'Widgets' })).toBeInTheDocument();
    expect(within(slides[4]!).getByText('Then')).toBeInTheDocument();
    expect(within(slides[4]!).getByText('Automatic')).toBeInTheDocument();
    expect(slides[1]).toHaveAccessibleName('Slide 2');
  });

  it('fills a section slide with the accent colour', () => {
    render(<PresentationPreview content={DECK} />);
    expect(screen.getByTestId('slide-3')).toHaveStyle({ background: '#AA3300' });
  });

  it('numbers the slides but not the title slide, and numbers a section slide in white', () => {
    render(<PresentationPreview content={DECK} />);
    expect(within(screen.getByTestId('slide-1')).queryByText('1')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('slide-2')).getByText('2')).toBeInTheDocument();
    expect(within(screen.getByTestId('slide-2')).getByText('2')).toHaveStyle({ color: '#808080' });
    expect(within(screen.getByTestId('slide-3')).getByText('3')).toHaveStyle({ color: '#ffffff' });
  });

  it("shows the parse error for a deck it can't read", () => {
    render(<PresentationPreview content={'{"slides":[]}'} />);
    expect(screen.getByRole('alert')).toHaveTextContent('slides: must be a list of 1-200 slides');
  });
});
