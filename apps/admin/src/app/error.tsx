'use client';

/** Unexpected failures: a plain message plus the digest the server logged it under. */
export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <main className="narrow">
      <h1>Something went wrong / कुछ गलत हो गया</h1>
      <p>Please try again. If it keeps happening, share this reference with the tech team.</p>
      {error.digest && (
        <p>
          <code>{error.digest}</code>
        </p>
      )}
    </main>
  );
}
