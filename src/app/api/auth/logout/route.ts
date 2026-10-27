import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Clears the session cookie. Public by design: clearing a cookie needs no identity. */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ type: "success" });
  response.cookies.set({
    name: "fqmg_session",
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
