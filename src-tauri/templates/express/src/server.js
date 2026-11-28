import express from "express";

const app = express();
const port = process.env.PORT ?? 3000;

app.use(express.json());

app.get("/", (_request, response) => {
  response.json({ name: "{{title}}", status: "ok" });
});

app.get("/api/hello", (request, response) => {
  const name = request.query.name ?? "world";
  response.json({ message: `Hello, ${name}!` });
});

app.listen(port, () => {
  console.log(`{{title}} listening on http://localhost:${port}`);
});
