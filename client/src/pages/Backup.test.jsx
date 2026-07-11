import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Backup from './Backup.jsx';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const sampleBackups = [
  {
    filename: 'carmaint-backup-2026-07-10T03-00-00.zip',
    size: 2048,
    created_at: '2026-07-10 03:00:00',
  },
  {
    filename: 'carmaint-backup-2026-07-09T03-00-00.zip',
    size: 5 * 1024 * 1024,
    created_at: '2026-07-09 03:00:00',
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  // Remove any Web Share API mocks added via defineProperty.
  delete window.navigator.canShare;
  delete window.navigator.share;
});

describe('Backup page', () => {
  it('renders all four sections with export/backup links and the backups table', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(sampleBackups));
    vi.stubGlobal('fetch', fetchMock);

    render(<Backup />);

    expect(screen.getByRole('heading', { name: /back up now/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /export history/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^restore$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /automatic backups/i })).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /download backup \(\.zip\)/i })).toHaveAttribute(
      'href',
      '/api/backup'
    );
    expect(screen.getByRole('link', { name: /all service history \(csv\)/i })).toHaveAttribute(
      'href',
      '/api/export.csv'
    );
    expect(screen.getByRole('link', { name: /complete data export \(json\)/i })).toHaveAttribute(
      'href',
      '/api/export.json'
    );

    // Automatic backups table from the mocked /api/backups.
    const firstRow = await screen.findByText('carmaint-backup-2026-07-10T03-00-00.zip');
    expect(firstRow.closest('a')).toHaveAttribute(
      'href',
      '/api/backups/carmaint-backup-2026-07-10T03-00-00.zip'
    );
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
    expect(screen.getByText('Jul 10, 2026')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith('/api/backups', expect.anything());
  });

  it('does not render the share button when the browser cannot share files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));

    render(<Backup />);

    // jsdom has no navigator.canShare / navigator.share.
    expect(
      screen.queryByRole('button', { name: /icloud or google drive/i })
    ).not.toBeInTheDocument();
    expect(await screen.findByText('No automatic backups yet')).toBeInTheDocument();
  });

  it('renders the share button when supported and shares the backup as a File', async () => {
    const user = userEvent.setup();
    const shareMock = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'canShare', {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(window.navigator, 'share', {
      configurable: true,
      writable: true,
      value: shareMock,
    });
    const fetchMock = vi.fn(async (url) =>
      url === '/api/backup'
        ? { ok: true, status: 200, blob: async () => new Blob(['zip-bytes']) }
        : jsonResponse([])
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<Backup />);

    const shareButton = screen.getByRole('button', { name: /icloud or google drive/i });
    await user.click(shareButton);

    await waitFor(() => expect(shareMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/backup');

    const shared = shareMock.mock.calls[0][0];
    expect(shared.title).toBe('CarMaint backup');
    expect(shared.files).toHaveLength(1);
    expect(shared.files[0]).toBeInstanceOf(File);
    expect(shared.files[0].name).toMatch(/^carmaint-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(shared.files[0].type).toBe('application/zip');
  });

  it('asks for confirmation with a strong warning before restoring', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));

    const { container } = render(<Backup />);

    const file = new File(['zip-bytes'], 'my-backup.zip', { type: 'application/zip' });
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });

    const dialog = screen.getByRole('dialog', { name: /restore from backup/i });
    expect(within(dialog).getByText(/my-backup\.zip/)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /replace everything/i })
    ).toBeInTheDocument();
  });
});
