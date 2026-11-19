import { createFileRoute } from "@tanstack/react-router";
import { T3ImportSettings } from "../components/settings/T3ImportSettings";

export const Route = createFileRoute("/_chat/settings/import")({ component: T3ImportSettings });
