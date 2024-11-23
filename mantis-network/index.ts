import * as pulumi from "@pulumi/pulumi";
import * as svmkit from "@svmkit/pulumi-svmkit";
import * as aws from "@pulumi/aws";
import * as tls from "@pulumi/tls";

const ami = pulumi.output(
  aws.ec2.getAmi({
    filters: [
      {
        name: "name",
        values: ["debian-12-*"],
      },
      {
        name: "architecture",
        values: ["x86_64"],
      },
    ],
    owners: ["136693071363"], // Debian
    mostRecent: true,
  })
).id;

const sshKey = new tls.PrivateKey("ssh-key", {
  algorithm: "ED25519",
});

const keyPair = new aws.ec2.KeyPair("keypair", {
  publicKey: sshKey.publicKeyOpenssh,
});

// Faucet for receiving SOL
const faucetKey = new svmkit.KeyPair("faucet-key");

// Treasury used to distribute stake
const treasuryKey = new svmkit.KeyPair("treasury-key");

// Bootstrap node
const identityKey = new svmkit.KeyPair("identity-key");
const voteAccountKey = new svmkit.KeyPair("vote-account-key");
const stakeAccountKey = new svmkit.KeyPair("stake-account-key");

const securityGroup = new aws.ec2.SecurityGroup("security-group", {
  description: "Allow SSH and specific inbound traffic",
  ingress: [
    {
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      protocol: "tcp",
      fromPort: 8000,
      toPort: 8020,
      cidrBlocks: ["0.0.0.0/0"],
    },
    {
      protocol: "udp",
      fromPort: 8000,
      toPort: 8020,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    },
  ],
});

const instance = new aws.ec2.Instance("instance", {
  ami,
  instanceType: "m5.2xlarge",
  keyName: keyPair.keyName,
  vpcSecurityGroupIds: [securityGroup.id],
  ebsBlockDevices: [
    {
      deviceName: "/dev/sdf",
      volumeSize: 250,
      volumeType: "io2",
      iops: 16000,
    },
    {
      deviceName: "/dev/sdg",
      volumeSize: 512,
      volumeType: "io2",
      iops: 16000,
    },
  ],
  userData: `#!/bin/bash
mkfs -t ext4 /dev/sdf
mkfs -t ext4 /dev/sdg
mkdir -p /home/sol/accounts
mkdir -p /home/sol/ledger
cat <<EOF >> /etc/fstab
/dev/sdf	/home/sol/accounts	ext4	defaults	0	0
/dev/sdg	/home/sol/ledger	ext4	defaults	0	0
EOF
systemctl daemon-reload
mount -a
`,
});

const connection = {
  host: instance.publicDns,
  user: "admin",
  privateKey: sshKey.privateKeyOpenssh,
};


const genesis = pulumi
.all([
    identityKey.publicKey,
    voteAccountKey.publicKey,
    stakeAccountKey.publicKey,
    faucetKey.publicKey,
    treasuryKey.publicKey,
])
.apply(
    ([
        identityPubkey,
        votePubkey,
        stakePubkey,
        faucetPubkey,
        treasuryPubkey,
    ]) => {
        const primordial = [
            {
                pubkey: identityPubkey,
                lamports: "10000000000", // 100 SOL
            },
            {
                pubkey: treasuryPubkey,
                lamports: "100000000000000", // 100000 SOL
            },
            {
                pubkey: faucetPubkey,
                lamports: "1000000000000", // 1000 SOL
            },
        ];

        return new svmkit.genesis.Solana(
            "genesis",
            {
                connection,
                flags: {
                    ledgerPath: "/home/sol/ledger",
                    identityPubkey,
                    votePubkey,
                    stakePubkey,
                    faucetPubkey,
                },
                primordial,
            },
            { dependsOn: [instance] },
        );
    },
);

identityKey.publicKey.apply((identityPubkey) => {
new svmkit.validator.Agave(
  "validator",
  {
    connection,
    variant: "mantis",
    keyPairs: {
      identity: identityKey.json,
      voteAccount: voteAccountKey.json,
    },
    flags: {
      expectedGenesisHash: genesis.genesisHash,
      useSnapshotArchivesAtStartup: "when-newest",
      rpcPort: 8899,
      privateRPC: false,
      onlyKnownRPC: false,
      allowPrivateAddr: true, 
      dynamicPortRange: "8002-8020",
      gossipPort: 8001,
      rpcBindAddress: "0.0.0.0",
      walRecoveryMode: "skip_any_corrupted_record",
      limitLedgerSize: 50000000,
      blockProductionMethod: "central-scheduler",
      fullRpcAPI: true,
      fullSnapshotIntervalSlots: 1000,
      noWaitForVoteToStartLeader: true,
      noVoting: false,
      gossipHost: instance.privateIp,
      extraFlags: [
          // Solana Explorer Flags
          "--enable-extended-tx-metadata-storage",
          "--enable-rpc-transaction-history",
          // Jito Flags
          ` --merkle-root-upload-authority=${identityPubkey}`,
          // TODO: Update genesis to include program if required
          // Reference: https://github.com/ComposableFi/mantis-solana/blob/50a3c502e6a43d839291e95968022e2ca16691a1/multinode-demo/bootstrap-validator.sh#L187
          "--tip-payment-program-pubkey=\"DThZmRNNXh7kvTQW9hXeGoWGPKktK8pgVAyoTLjH7UrT\"",
          "--tip-distribution-program-pubkey=\"FjrdANjvo76aCYQ4kf9FM1R8aESUcEE6F8V7qyoVUQcM\"",
          "--commission-bps=0",
      ]
    },
  },
  {
    dependsOn: [instance],
  }
);

})


export const PUBLIC_DNS_NAME = instance.publicDns;
export const SSH_PRIVATE_KEY = sshKey.privateKeyOpenssh;
