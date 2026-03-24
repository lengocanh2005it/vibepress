function root(req, res) {
	res.send('Express server is running');
}

function health(req, res) {
	res.status(200).json({ status: 'ok' });
}

module.exports = {
	root,
	health,
};
