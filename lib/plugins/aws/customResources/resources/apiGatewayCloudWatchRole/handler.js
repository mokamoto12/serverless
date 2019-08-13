'use strict';

const ApiGateway = require('aws-sdk/clients/apigateway');
const Iam = require('aws-sdk/clients/iam');
const { getEnvironment, handlerWrapper, wait } = require('../utils');

function handler(event, context) {
  if (event.RequestType === 'Create') {
    return create(event, context);
  } else if (event.RequestType === 'Update') {
    return update(event, context);
  } else if (event.RequestType === 'Delete') {
    return remove(event, context);
  }
  throw new Error(`Unhandled RequestType ${event.RequestType}`);
}

async function create(event, context) {
  const { AccountId: accountId } = getEnvironment(context);

  const apiGatewayPushToCloudWatchLogsPolicyArn =
    'arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs';
  const defaultRoleArn = `arn:aws:iam::${accountId}:role/serverlessApiGatewayCloudWatchRole'`;

  const apiGateway = new ApiGateway();

  const assignedRoleArn = (await apiGateway.getAccount().promise()).cloudwatchRoleArn;
  const roleArn = assignedRoleArn || defaultRoleArn;
  const roleName = roleArn.slice(roleArn.lastIndexOf('/') + 1);

  const iam = new Iam();

  const attachedPolicies = await (async () => {
    try {
      return (await iam.listAttachedRolePolicies({ RoleName: roleName }).promise())
        .AttachedPolicies;
    } catch (error) {
      if (error.code === 'NoSuchEntity') {
        // Role doesn't exist yet, create;
        await iam
          .createRole({
            AssumeRolePolicyDocument: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Principal: {
                    Service: ['apigateway.amazonaws.com'],
                  },
                  Action: ['sts:AssumeRole'],
                },
              ],
            }),
            Path: '/',
            RoleName: roleName,
          })
          .promise();
        return [];
      }
      throw error;
    }
  })();

  if (
    !attachedPolicies.some(policy => policy.PolicyArn === apiGatewayPushToCloudWatchLogsPolicyArn)
  ) {
    await iam
      .attachRolePolicy({
        PolicyArn: apiGatewayPushToCloudWatchLogsPolicyArn,
        RoleName: roleName,
      })
      .promise();
  }

  if (assignedRoleArn === roleArn) return null;

  const codes = [];
  const updateAccount = async (counter = 1) => {
    try {
      const result = await apiGateway
        .updateAccount({
          patchOperations: [
            {
              op: 'replace',
              path: '/cloudwatchRoleArn',
              value: roleArn,
            },
          ],
        })
        .promise();
      return { codes, result };
    } catch (error) {
      if (counter < 10) {
        await wait(10000);
        codes.push(error.code);
        return updateAccount(++counter);
      }
      return { command: 'updateAccount', counter, error };
    }
  };

  return updateAccount();
}

function update() {
  // No actions
}

function remove() {
  // No actions
}

module.exports = {
  handler: handlerWrapper(handler, 'CustomResouceApiGatewayAccountCloudWatchRole'),
};
