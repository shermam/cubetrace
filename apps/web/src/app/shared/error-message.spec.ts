import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('reads the message of errors and DOM exceptions, and prints anything else', () => {
    expect(errorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(errorMessage(new DOMException('Write permission denied.', 'NotAllowedError'))).toBe(
      'Write permission denied.',
    );
    expect(errorMessage({ message: 42 })).toBe('[object Object]');
    expect(errorMessage('offline')).toBe('offline');
  });
});
