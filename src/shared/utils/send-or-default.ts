export async function sendWithExpectedError<T>(
  send: () => Promise<T>,
  expectedErrorName: string,
): Promise<T | null> {
  try {
    return await send();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === expectedErrorName) {
      return null;
    }
    throw err;
  }
}
