import { expect } from "bun:test";
import type { CheckRequest } from "../../src/core/types.ts";
import type { FgaClient } from "../../src/index.ts";
import { fgaCheck } from "./openfga.ts";

/**
 * Assert that fga-ts and OpenFGA return the same result for a permission check.
 * Runs both checks in parallel for speed.
 */
export async function expectConformance(
	storeId: string,
	authorizationModelId: string,
	fgaClient: FgaClient,
	params: CheckRequest,
	expected: boolean,
): Promise<void> {
	const [fgaTsResult, openFgaResult] = await Promise.all([
		fgaClient.check(params),
		fgaCheck(storeId, authorizationModelId, {
			objectType: params.objectType,
			objectId: params.objectId,
			relation: params.relation,
			subjectType: params.subjectType,
			subjectId: params.subjectId,
			context: params.context,
		}),
	]);

	if (openFgaResult === null) {
		throw new Error("OpenFGA returned an error");
	}

	// Both systems must agree
	expect(fgaTsResult).toBe(openFgaResult);
	// And match expected value
	expect(fgaTsResult).toBe(expected);
}
