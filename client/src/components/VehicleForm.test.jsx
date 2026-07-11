import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VehicleForm from './VehicleForm.jsx';

describe('VehicleForm', () => {
  it('shows inline errors and blocks submit when required fields are missing', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(screen.getByText('Make is required')).toBeInTheDocument();
    expect(screen.getByText('Model is required')).toBeInTheDocument();
    expect(screen.getByText('Year is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range year and blocks submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/make/i), 'Honda');
    await user.type(screen.getByLabelText(/model/i), 'Civic');
    await user.type(screen.getByLabelText(/year/i), '1850');
    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(screen.getByText('Enter a year between 1900 and 2100')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a negative mileage', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/make/i), 'Honda');
    await user.type(screen.getByLabelText(/model/i), 'Civic');
    await user.type(screen.getByLabelText(/year/i), '2021');
    await user.type(screen.getByLabelText(/current mileage/i), '-5');
    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(
      screen.getByText('Mileage must be a whole number of 0 or more')
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits trimmed, typed values when valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/make/i), '  Honda ');
    await user.type(screen.getByLabelText(/model/i), 'Civic');
    await user.type(screen.getByLabelText(/year/i), '2021');
    await user.type(screen.getByLabelText(/current mileage/i), '45210');
    await user.click(screen.getByRole('button', { name: /save vehicle/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        make: 'Honda',
        model: 'Civic',
        year: 2021,
        current_mileage: 45210,
      })
    );
    expect(screen.queryByText('Make is required')).not.toBeInTheDocument();
  });

  it('calls onCancel from the cancel button without submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<VehicleForm onSubmit={onSubmit} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
