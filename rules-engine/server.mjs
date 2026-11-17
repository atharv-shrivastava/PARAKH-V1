export default function handler(_req, res) {
  res.statusCode = 503;
  res.end("Rules Engine build artifact is not ready.");
}
