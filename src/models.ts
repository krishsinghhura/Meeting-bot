export type MeetingTranscript = {
  meetingId: string;
  createdAt: Date;
  segments: Segment[];
};

export type Segment = {
  start: number;
  end: number;
  text: string;
  speaker: string;
};

export type MeetingActionItem = {
  task: string;
  owner: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high";
};

export type MeetingAnalysis = {
  title: string;
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: MeetingActionItem[];
  questions: string[];
  followUps: string[];
  participants: string[];
};

export type MeetingAiResultInput = {
  meetingId: string;
  kind: string;
  model: string;
  outputJson: MeetingAnalysis;
  generatedAt: Date;
};

export type MeetingSummaryInput = {
  meetingId: string;
  generatedAt: Date;
  summaryText: string;
  model: "gpt-4-turbo" | string;
};
/*
    export type MediaAsset = {
    meetingId: string;
    createdAt: Date;
    type: 'audio' | 'video';
    storagePath: string;
    durationSec: number;
    };*/
