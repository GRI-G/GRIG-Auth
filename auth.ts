"use strict";

import { APIGatewayEvent } from "aws-lambda";

import { serverless_DTO } from "./DTO";

import { UserModel } from "./model/users";
import { CodeModel } from "./model/code";

import { getAccessTokenByCode, getUserByToken } from "./util/github";
import { generateToken, verifyToken } from "./util/token";
import { sendAuthMessage } from "./util/email";

import {
  createUser,
  createToken,
  updateUserInformation,
  findUserByNickname,
  testIsGSMEmail,
} from "./util/user";
import { connectMongoDB } from "./util/db";

const createRes: Function = (
  status: number,
  body?: Object,
  headers?: Object,
): serverless_DTO.Response => {
  return {
    statusCode: status,
    body: JSON.stringify(body),
    headers: headers || {},
  };
};

exports.authUserByOAuth = async (
  event: APIGatewayEvent,
  _: any,
  __: Function,
) => {
  const data = event.queryStringParameters;
  if (data?.code === undefined) {
    return createRes(404, {}, { message: "bad request" });
  }

  const access_token = (await getAccessTokenByCode(data.code)).access_token;
  const { name, nickname } = await getUserByToken(access_token);
  const code = generateToken({ nickname: nickname }, "180m");

  let page = "complete.html";
  const user = await findUserByNickname(nickname);
  if (!user?.certified) {
    if (!user) {
      await createUser({
        accessToken: access_token,
        name: name ?? " ",
        nickname: nickname,
      });
    }

    page = "email_auth.html";
  }

  return createRes(
    302,
    {},
    { Location: `${process.env.AUTH_BASEURL}${page}?code=${code}` },
  );
};

exports.authEmail = async (event: APIGatewayEvent, _: any, __: Function) => {
  if (event.body === null) {
    return createRes(404, {}, { message: "bad request" });
  }

  const searchPrams = new URLSearchParams(event.body);
  const code = searchPrams.get("code");
  const email = searchPrams.get("email");

  if (!testIsGSMEmail(email)) {
    return createRes(400, { detail: "GSM 학생 계정이어야합니다." });
  }

  const nickname = verifyToken(code).nickname;
  const token = await createToken({ email: email, nickname: nickname });
  await sendAuthMessage({
    receiver: email,
    nickname: nickname,
    token: token.id,
  });
  return createRes(204);
};

exports.authUserByEmail = connectMongoDB(
  async (event: APIGatewayEvent, _: any) => {
    if (event.pathParameters === null) {
      return createRes(404, {}, { message: "bad request" });
    }
    const dataId = event.pathParameters["token"];
    const data = await CodeModel.findById(dataId);
    if (data === null) {
      return createRes(404, {}, { message: "bad request" });
    }

    const email = data.email;
    const nickname = data.nickname;
    const generation = testIsGSMEmail(email)
      ? Number(email.replace(/[^0-9]/g, "").slice(0, 2)) - 16
      : 0;

    if (generation === 0) {
      createRes(404, { message: "GSM 학생이 아닙니다." });
    }

    const user = await UserModel.findUserFromNickname(nickname);
    if (user === null) {
      return createRes(404, {}, { message: "bad request" });
    }

    try {
      await user.updateGeneration(generation);
      console.log("Success update Generation");
      await user.setCertifiedTrue();
      console.log("Success Set Certified True");
      await updateUserInformation(user);
      console.log("Update User Information");
    } catch (e: any) {
      console.error(e);
    }

    await CodeModel.findByIdAndDelete(dataId);
    console.log("Success find By Id and delete data Id");

    return createRes(
      302,
      {},
      { Location: `${process.env.AUTH_BASEURL}complete.html` },
    );
  },
);
