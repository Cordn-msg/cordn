import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  credentialTypes,
  defaultCapabilities,
  defaultLifetime,
  decodeMlsMessage,
  emptyPskIndex,
  encodeMlsMessage,
  generateKeyPackage,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  type ClientState,
  type CiphersuiteImpl,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
} from 'ts-mls';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { keyPackageEncoder } from 'ts-mls/keyPackage.js';

const CIPHERSUITE_NAME = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519' as const;

export type KeyPackagePublication = {
  key_package_ref: string;
  key_package: string;
};

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return new Uint8Array(Buffer.from(`${normalized}${padding}`, 'base64'));
}

function decodeMessage(bytes: Uint8Array): MLSMessage {
  const decoded = decodeMlsMessage(bytes, 0);
  if (!decoded) {
    throw new Error('failed to decode MLS message');
  }

  return decoded[0];
}

function assertPrivateMessage(message: MLSMessage): asserts message is Extract<MLSMessage, { wireformat: 'mls_private_message' }> {
  if (message.wireformat !== 'mls_private_message') {
    throw new Error(`expected private message, got ${message.wireformat}`);
  }
}

function assertWelcomeMessage(message: MLSMessage): asserts message is Extract<MLSMessage, { wireformat: 'mls_welcome' }> {
  if (message.wireformat !== 'mls_welcome') {
    throw new Error(`expected welcome message, got ${message.wireformat}`);
  }
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeWithEncoder<T>(encoder: (value: T) => [number, (offset: number, buffer: ArrayBuffer) => void], value: T): Uint8Array {
  const [length, write] = encoder(value);
  const buffer = new ArrayBuffer(length);
  write(0, buffer);
  return new Uint8Array(buffer);
}

export class MlsActor {
  private constructor(
    readonly stableIdentity: string,
    readonly deliveryAddress: string,
    private readonly keyPackage: KeyPackage,
    private readonly privateKeyPackage: PrivateKeyPackage,
    private state: ClientState | null,
    private readonly cipherSuite: CiphersuiteImpl,
  ) {}

  static async create(stableIdentity: string, deliveryAddress: string): Promise<MlsActor> {
    const cipherSuite = await getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE_NAME));
    const credential = {
      credentialType: 'basic' as const,
      identity: encodeText(stableIdentity),
    };

    const generated = await generateKeyPackage(
      credential,
      defaultCapabilities(),
      defaultLifetime,
      [],
      cipherSuite,
    );

    return new MlsActor(
      stableIdentity,
      deliveryAddress,
      generated.publicPackage,
      generated.privatePackage,
      null,
      cipherSuite,
    );
  }

  async exportPublication(): Promise<KeyPackagePublication> {
    const keyPackageRef = await makeKeyPackageRef(this.keyPackage, this.cipherSuite.hash);
    const keyPackageBytes = encodeWithEncoder(keyPackageEncoder, this.keyPackage);

    return {
      key_package_ref: toBase64Url(keyPackageRef),
      key_package: toBase64Url(keyPackageBytes),
    };
  }

  async createGroup(groupIdText: string): Promise<{ groupIdBase64Url: string; epoch: number }> {
    this.state = await createGroup(encodeText(groupIdText), this.keyPackage, this.privateKeyPackage, [], this.cipherSuite);

    return {
      groupIdBase64Url: toBase64Url(this.state.groupContext.groupId),
      epoch: Number(this.state.groupContext.epoch),
    };
  }

  async createAddCommit(joinerKeyPackageBytesBase64Url: string): Promise<{
    commitBytesBase64Url: string;
    welcomeBytesBase64Url: string;
    groupIdBase64Url: string;
    epoch: number;
  }> {
    const decodedJoiner = decodeMessage(fromBase64Url(joinerKeyPackageBytesBase64Url));
    if (decodedJoiner.wireformat !== 'mls_key_package') {
      throw new Error(`expected key package, got ${decodedJoiner.wireformat}`);
    }

    const currentState = this.requireState();
    const result = await createCommit({
      state: currentState,
      cipherSuite: this.cipherSuite,
      pskIndex: emptyPskIndex,
    }, {
      extraProposals: [
        {
          proposalType: 'add',
          add: {
            keyPackage: decodedJoiner.keyPackage,
          },
        },
      ],
    });

    this.state = result.newState;

    if (!result.welcome) {
      throw new Error('commit did not produce a welcome message');
    }

    const commitBytes = encodeMlsMessage(result.commit);
    const welcomeBytes = encodeMlsMessage({
      version: 'mls10',
      wireformat: 'mls_welcome',
      welcome: result.welcome,
    });

    return {
      commitBytesBase64Url: toBase64Url(commitBytes),
      welcomeBytesBase64Url: toBase64Url(welcomeBytes),
      groupIdBase64Url: toBase64Url(result.newState.groupContext.groupId),
      epoch: Number(result.newState.groupContext.epoch),
    };
  }

  async joinFromWelcome(welcomeBytesBase64Url: string, ratchetTreeSource: MlsActor): Promise<number> {
    const decodedWelcome = decodeMessage(fromBase64Url(welcomeBytesBase64Url));
    assertWelcomeMessage(decodedWelcome);

    this.state = await joinGroup(
      decodedWelcome.welcome,
      this.keyPackage,
      this.privateKeyPackage,
      emptyPskIndex,
      this.cipherSuite,
      ratchetTreeSource.requireState().ratchetTree,
    );

    return Number(this.state.groupContext.epoch);
  }

  async processCommit(commitBytesBase64Url: string): Promise<number> {
    const decodedCommit = decodeMessage(fromBase64Url(commitBytesBase64Url));
    assertPrivateMessage(decodedCommit);

    const result = await processMessage(decodedCommit, this.requireState(), emptyPskIndex, acceptAll, this.cipherSuite);

    if (result.kind !== 'newState') {
      throw new Error('expected commit processing to yield new state');
    }

    this.state = result.newState;
    return Number(this.state.groupContext.epoch);
  }

  async createApplicationMessage(text: string): Promise<{ messageBytesBase64Url: string; epoch: number }> {
    const result = await createApplicationMessage(this.requireState(), encodeText(text), this.cipherSuite);

    this.state = result.newState;

    return {
      messageBytesBase64Url: toBase64Url(
        encodeMlsMessage({
          version: 'mls10',
          wireformat: 'mls_private_message',
          privateMessage: result.privateMessage,
        }),
      ),
      epoch: Number(this.state.groupContext.epoch),
    };
  }

  async processApplicationMessage(messageBytesBase64Url: string): Promise<string> {
    const decodedMessage = decodeMessage(fromBase64Url(messageBytesBase64Url));
    assertPrivateMessage(decodedMessage);

    const result = await processMessage(decodedMessage, this.requireState(), emptyPskIndex, acceptAll, this.cipherSuite);

    if (result.kind !== 'applicationMessage') {
      throw new Error('expected application message result');
    }

    this.state = result.newState;

    return new TextDecoder().decode(result.message);
  }

  private requireState(): ClientState {
    if (!this.state) {
      throw new Error(`MLS state not initialized for ${this.stableIdentity}`);
    }

    return this.state;
  }
}
