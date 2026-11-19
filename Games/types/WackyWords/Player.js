const Player = require("../../core/Player");

module.exports = class WackyWordsPlayer extends Player {
  constructor(user, game, isBot) {
    super(user, game, isBot);

    this.score = 0;
    this.question = null;
    this.response = null;
  }

  hasVotedInAllMeetings() {
    // Speed Up is a shortcut, not a required action. Keep all other meetings
    // subject to the shared completion rules without changing Mafia's policy.
    return super.hasVotedInAllMeetings(
      this.getMeetings().filter((meeting) => meeting !== this.game.speedUpMeeting)
    );
  }

  addScore(score) {
    this.score += score;
  }

  getScore() {
    return this.score;
  }

  // to hide the alert
  setRole(roleName) {
    super.setRole(roleName, undefined, false, true);
  }
};
