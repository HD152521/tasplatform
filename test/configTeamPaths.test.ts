/**
 * 팀별 세션/기기신뢰 파일 경로 헬퍼.
 *
 * 기본 팀은 반드시 기존 SESSION_FILE/DEVICE_FILE 그대로 반환해야 한다 —
 * 실사용 중인 수집기가 파일 경로 변경만으로 깨지면 안 된다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TEAM_ID,
  DEVICE_FILE,
  SESSION_FILE,
  assertValidTeamId,
  deviceFileForTeam,
  sessionFileForTeam,
} from "../lib/config.ts";

test("teamId 를 생략하면 기존 SESSION_FILE 을 그대로 준다", () => {
  assert.equal(sessionFileForTeam(), SESSION_FILE);
});

test("teamId 를 생략하면 기존 DEVICE_FILE 을 그대로 준다", () => {
  assert.equal(deviceFileForTeam(), DEVICE_FILE);
});

test("기본 팀 id 를 명시해도 기존 파일과 동일하다", () => {
  assert.equal(sessionFileForTeam(DEFAULT_TEAM_ID), SESSION_FILE);
  assert.equal(deviceFileForTeam(DEFAULT_TEAM_ID), DEVICE_FILE);
});

test("다른 팀은 팀별 하위 경로로 분리된다", () => {
  assert.equal(sessionFileForTeam("acme"), "data/teams/acme/session.json");
  assert.equal(deviceFileForTeam("acme"), "data/teams/acme/device.json");
});

test("서로 다른 팀은 서로 다른 파일을 가리킨다", () => {
  assert.notEqual(sessionFileForTeam("acme"), sessionFileForTeam("beta"));
  assert.notEqual(deviceFileForTeam("acme"), deviceFileForTeam("beta"));
});

test("타팀 경로는 기본 팀 경로와 절대 겹치지 않는다", () => {
  assert.notEqual(sessionFileForTeam("acme"), SESSION_FILE);
  assert.notEqual(deviceFileForTeam("acme"), DEVICE_FILE);
});

test("허용된 형식의 팀 id 는 통과한다", () => {
  assert.doesNotThrow(() => assertValidTeamId("default"));
  assert.doesNotThrow(() => assertValidTeamId("team-1"));
  assert.doesNotThrow(() => assertValidTeamId("acme_2"));
});

test("경로 탈출을 노리는 teamId 는 거부한다 (../)", () => {
  assert.throws(() => assertValidTeamId("../x"));
  assert.throws(() => sessionFileForTeam("../x"));
  assert.throws(() => deviceFileForTeam("../x"));
});

test("슬래시가 섞인 teamId 는 거부한다 (a/b)", () => {
  assert.throws(() => assertValidTeamId("a/b"));
  assert.throws(() => sessionFileForTeam("a/b"));
  assert.throws(() => deviceFileForTeam("a/b"));
});

test("역슬래시가 섞인 teamId 는 거부한다 (a\\\\b)", () => {
  assert.throws(() => assertValidTeamId("a\\b"));
  assert.throws(() => sessionFileForTeam("a\\b"));
  assert.throws(() => deviceFileForTeam("a\\b"));
});

test("상위 디렉터리 표기(..) 자체도 거부한다", () => {
  assert.throws(() => assertValidTeamId(".."));
  assert.throws(() => sessionFileForTeam(".."));
  assert.throws(() => deviceFileForTeam(".."));
});

test("빈 문자열 teamId 는 거부한다", () => {
  assert.throws(() => assertValidTeamId(""));
  assert.throws(() => sessionFileForTeam(""));
  assert.throws(() => deviceFileForTeam(""));
});

test("기본 팀은 검증을 거치되 통과하며 기존 경로를 그대로 준다", () => {
  assert.doesNotThrow(() => assertValidTeamId(DEFAULT_TEAM_ID));
  assert.equal(sessionFileForTeam(DEFAULT_TEAM_ID), SESSION_FILE);
  assert.equal(deviceFileForTeam(DEFAULT_TEAM_ID), DEVICE_FILE);
});
