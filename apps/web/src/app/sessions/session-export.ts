/** The file name of a session's export (the Sessions page and a session's page). */
export function exportFileName(sessionId: string): string {
  return `cubetrace-session-${sessionId}.json`;
}
