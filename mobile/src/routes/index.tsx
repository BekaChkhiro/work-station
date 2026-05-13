import { Navigate } from "@solidjs/router";
import { recallTab } from "../components/TabBar";

export default function Home() {
  return <Navigate href={recallTab()} />;
}
