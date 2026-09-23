/** A text field from a submitted form ('' when missing or a file). */
export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
