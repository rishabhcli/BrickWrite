import express, { Request, Response } from "express";
import { GenerationEngine } from "../../src/generation/engine";
import { DesignBriefV1 } from "../../src/generation/types";

// Simple router exposing a POST /generate endpoint
const router = express.Router();
import { StreamingPlaceholderProvider } from "../assistant/modelProvider";
const engine = new GenerationEngine(new StreamingPlaceholderProvider());

router.post("/generate", async (req: Request, res: Response) => {
  try {
    // Validate body against DesignBriefV1 schema
    const brief = DesignBriefV1.parse(req.body);
    // Listen for phase events just to log – in a real server they could be streamed
    const phases: string[] = [];
    const listener = (event: unknown) => {
      phases.push(JSON.stringify(event));
    };
    engine.once("rough", listener);
    engine.once("structure", listener);
    engine.once("detail", listener);
    await engine.generate(brief);
    res.json({ status: "ok", phases });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: (e as any).message ?? "Invalid request" });
  }
});

export default router;
