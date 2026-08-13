import { Request, Response, NextFunction } from "express";

export default function handleError(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof SyntaxError) {
    console.error(`❌[SYNTAX ERROR]: ${err}`);
  } else if (err instanceof TypeError) {
    console.error(`❌[TYPE ERROR]: ${err}`);
  } else if (err instanceof ReferenceError) {
    console.error(`❌[REF ERROR]: ${err}`);
  } else {
    console.error(`❌[ERROR]: ${err}`);
  }
}
