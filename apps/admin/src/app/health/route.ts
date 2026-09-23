/** Load balancer check for the admin panel server itself. */
export function GET() {
  return Response.json({ status: 'ok' });
}
