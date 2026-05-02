export class CliSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnknownGroupAliasError extends CliSessionError {
  constructor(alias: string) {
    super(`Unknown group alias: ${alias}`);
  }
}

export class DuplicateGroupAliasError extends CliSessionError {
  constructor(alias: string) {
    super(`Group alias already exists: ${alias}`);
  }
}

export class DuplicateKeyPackageAliasError extends CliSessionError {
  constructor(alias: string) {
    super(`Key package alias already exists: ${alias}`);
  }
}

export class UnknownKeyPackageAliasError extends CliSessionError {
  constructor(alias: string) {
    super(`Unknown key package alias: ${alias}`);
  }
}

export class NoAvailableKeyPackageError extends CliSessionError {
  constructor() {
    super("No available local key package. Generate one first.");
  }
}

export class UnknownWelcomeReferenceError extends CliSessionError {
  constructor(keyPackageReference: string) {
    super(`Unknown welcome key package reference: ${keyPackageReference}`);
  }
}

export class MissingLocalKeyPackageForWelcomeError extends CliSessionError {
  constructor(keyPackageReference: string) {
    super(
      `No local key package matches welcome reference ${keyPackageReference}`,
    );
  }
}

export class NoPublishedKeyPackageError extends CliSessionError {
  constructor(identifier: string) {
    super(`No published key package available for ${identifier}`);
  }
}

export class InvalidConsumedKeyPackageError extends CliSessionError {
  constructor() {
    super("Unable to decode consumed key package");
  }
}

export class InvalidMlsMessageError extends CliSessionError {
  constructor(message = "Unable to decode MLS message") {
    super(message);
  }
}

export class InvalidWelcomeMessageError extends CliSessionError {
  constructor() {
    super("Expected MLS welcome message");
  }
}

export class MissingCommitWelcomeError extends CliSessionError {
  constructor() {
    super("Expected add-member commit to produce a welcome");
  }
}

export class CliUsageError extends CliSessionError {
  constructor(message: string) {
    super(message);
  }
}

export class UnknownCommandError extends CliUsageError {
  constructor(command: string) {
    super(`Unknown command: ${command}`);
  }
}
