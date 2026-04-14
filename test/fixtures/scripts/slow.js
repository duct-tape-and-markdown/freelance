/**
 * Test hook fixture: sleeps longer than any reasonable test timeout so
 * we can verify that the hook runner enforces its per-hook timeout.
 */
export default function () {
  return new Promise((resolve) => {
    setTimeout(() => resolve({ tooLate: true }), 5000);
  });
}
