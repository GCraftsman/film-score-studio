import { Router, type IRouter } from "express";
import composeRouter from "./compose";
import healthRouter from "./health";
import projectsRouter from "./projects";

const router: IRouter = Router();

router.use(healthRouter);
router.use(composeRouter);
router.use(projectsRouter);

export default router;
