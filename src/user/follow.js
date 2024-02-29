
'use strict';

const notifications = require('../notifications');
const plugins = require('../plugins');
const activitypub = require('../activitypub');
const db = require('../database');

module.exports = function (User) {
	User.follow = async function (uid, followuid) {
		await toggleFollow('follow', uid, followuid);
	};

	User.unfollow = async function (uid, unfollowuid) {
		await toggleFollow('unfollow', uid, unfollowuid);
	};

	async function toggleFollow(type, uid, theiruid) {
		if (parseInt(uid, 10) <= 0 || parseInt(theiruid, 10) <= 0) {
			throw new Error('[[error:invalid-uid]]');
		}

		if (parseInt(uid, 10) === parseInt(theiruid, 10)) {
			throw new Error('[[error:you-cant-follow-yourself]]');
		}
		const exists = await User.exists(theiruid);
		if (!exists) {
			throw new Error('[[error:no-user]]');
		}
		const isFollowing = await User.isFollowing(uid, theiruid);
		if (type === 'follow') {
			if (isFollowing) {
				throw new Error('[[error:already-following]]');
			}
			const now = Date.now();
			await Promise.all([
				db.sortedSetAddBulk([
					[`following:${uid}`, now, theiruid],
					[`followers:${theiruid}`, now, uid],
				]),
			]);
		} else {
			if (!isFollowing) {
				throw new Error('[[error:not-following]]');
			}
			await Promise.all([
				db.sortedSetRemoveBulk([
					[`following:${uid}`, theiruid],
					[`followers:${theiruid}`, uid],
				]),
			]);
		}

		const [followingCount, followingRemoteCount, followerCount, followerRemoteCount] = await Promise.all([
			db.sortedSetCard(`following:${uid}`),
			db.sortedSetCard(`followingRemote:${uid}`),
			db.sortedSetCard(`followers:${theiruid}`),
			db.sortedSetCard(`followersRemote:${theiruid}`),
		]);
		await Promise.all([
			User.setUserField(uid, 'followingCount', followingCount + followingRemoteCount),
			User.setUserField(theiruid, 'followerCount', followerCount + followerRemoteCount),
		]);
	}

	User.getFollowing = async function (uid, start, stop) {
		return await getFollow(uid, 'following', start, stop);
	};

	User.getFollowers = async function (uid, start, stop) {
		return await getFollow(uid, 'followers', start, stop);
	};

	async function getFollow(uid, type, start, stop) {
		if (parseInt(uid, 10) <= 0) {
			return [];
		}
		const uids = await db.getSortedSetRevRange([
			`${type}:${uid}`,
			`${type}Remote:${uid}`,
		], start, stop);

		const data = await plugins.hooks.fire(`filter:user.${type}`, {
			uids: uids,
			uid: uid,
			start: start,
			stop: stop,
		});
		return await User.getUsers(data.uids, uid);
	}

	User.isFollowing = async function (uid, theirid) {
		const isRemote = activitypub.helpers.isUri(theirid);
		if (parseInt(uid, 10) <= 0 || (!isRemote && (theirid, 10) <= 0)) {
			return false;
		}
		const setPrefix = isRemote ? 'followingRemote' : 'following';
		return await db.isSortedSetMember(`${setPrefix}:${uid}`, theirid);
	};

	User.onFollow = async function (uid, targetUid) {
		const userData = await User.getUserFields(uid, ['username', 'userslug']);
		const { displayname } = userData;

		const notifObj = await notifications.create({
			type: 'follow',
			bodyShort: `[[notifications:user-started-following-you, ${displayname}]]`,
			nid: `follow:${targetUid}:uid:${uid}`,
			from: uid,
			path: `/uid/${targetUid}/followers`,
			mergeId: 'notifications:user-started-following-you',
		});
		if (!notifObj) {
			return;
		}
		notifObj.user = userData;
		await notifications.push(notifObj, [targetUid]);
	};
};
