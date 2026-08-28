import express from "express";
import generationRouter from "./generation/api.js";

const app = express();
app.use(express.json());
app.use("/api", generationRouter);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(port, () => {
  console.log(`🚀 Generation server listening on http://localhost:${port}`);
});
