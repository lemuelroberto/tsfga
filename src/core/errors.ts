export class FgaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FgaError";
	}
}

export class RelationConfigNotFoundError extends FgaError {
	constructor(objectType: string, relation: string) {
		super(`No relation config found for ${objectType}.${relation}`);
		this.name = "RelationConfigNotFoundError";
	}
}

export class InvalidSubjectTypeError extends FgaError {
	constructor(
		subjectType: string,
		objectType: string,
		relation: string,
		allowed: string[],
	) {
		super(
			`Subject type '${subjectType}' is not allowed for ${objectType}.${relation}. Allowed: ${allowed.join(", ")}`,
		);
		this.name = "InvalidSubjectTypeError";
	}
}

export class UsersetNotAllowedError extends FgaError {
	constructor(objectType: string, relation: string) {
		super(`Userset subjects are not allowed for ${objectType}.${relation}`);
		this.name = "UsersetNotAllowedError";
	}
}

export class ConditionNotFoundError extends FgaError {
	constructor(conditionName: string) {
		super(`Condition definition not found: ${conditionName}`);
		this.name = "ConditionNotFoundError";
	}
}

export class ConditionEvaluationError extends FgaError {
	override cause: unknown;
	constructor(conditionName: string, cause: unknown) {
		super(`Failed to evaluate condition '${conditionName}': ${cause}`);
		this.name = "ConditionEvaluationError";
		this.cause = cause;
	}
}
